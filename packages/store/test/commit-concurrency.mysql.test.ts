import { randomBytes } from "node:crypto";
import mysql, { type Connection, type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Event, emptyUsage, type Approval, type Item, type Session, type Turn } from "@agent-service/protocol";
import { MysqlSessionStore, type CommitBatch, type CommitResult } from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const describeMysql = process.env.AGENT_SERVICE_INTEGRATION ? describe : describe.skip;
const DATABASE_NAME = /^agent_service_test_commit_concurrency_[0-9a-f]{20}$/;

function disposableBase(): URL {
  const raw = process.env.MYSQL_TEST_URL;
  if (!raw) throw new Error("MYSQL_TEST_URL is required for commit concurrency integration");
  const url = new URL(raw);
  const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])test(?:$|[_-])/i.test(name)) {
    throw new Error("commit concurrency requires a local disposable MySQL test target");
  }
  return url;
}
function databaseUrl(base: URL, name: string): string {
  const url = new URL(base); url.pathname = `/${name}`; return url.toString();
}
function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}

/** The barrier delays dispatch only. Every SQL statement still runs on its real InnoDB connection. */
class FirstItemInsertBarrier {
  readonly arrivals = new Set<string>();
  private release!: () => void;
  private reject!: (error: Error) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly gate = new Promise<void>((resolve, reject) => { this.release = resolve; this.reject = reject; });

  async arrive(label: string): Promise<void> {
    if (this.arrivals.has(label)) throw new Error("commit fixture repeated first INSERT barrier");
    this.arrivals.add(label);
    if (!this.timer) this.timer = setTimeout(() => this.reject(new Error("commit fixture INSERT barrier was not reached by both transactions")), 5_000);
    if (this.arrivals.size === 2) { clearTimeout(this.timer); this.release(); }
    await this.gate;
  }
  dispose(): void { if (this.timer) clearTimeout(this.timer); this.release(); }
}

function interceptFirstItemInsert(store: MysqlSessionStore, barrier: FirstItemInsertBarrier, label: string): () => void {
  const pool = (store as unknown as { pool: Pool }).pool;
  const getConnection = pool.getConnection.bind(pool);
  let restoreQuery: (() => void) | undefined;
  const acquire = vi.spyOn(pool, "getConnection").mockImplementationOnce(async () => {
    const connection: PoolConnection = await getConnection();
    const query = connection.query.bind(connection);
    let reached = false;
    const querySpy = vi.spyOn(connection, "query").mockImplementation((async (...args: unknown[]) => {
      const statement = typeof args[0] === "string" ? args[0] : "";
      if (!reached && /^\s*INSERT\s+INTO\s+items\b/i.test(statement)) {
        reached = true;
        await barrier.arrive(label);
      }
      return Reflect.apply(query, connection, args);
    }) as PoolConnection["query"]);
    restoreQuery = () => querySpy.mockRestore();
    return connection;
  });
  return () => { restoreQuery?.(); acquire.mockRestore(); };
}

function pauseAfterRealItemProbe(store: MysqlSessionStore, itemId: string) {
  const pool = (store as unknown as { pool: Pool }).pool;
  const getConnection = pool.getConnection.bind(pool);
  let signalReached!: () => void, signalResume!: () => void, rejectReached!: (error: Error) => void;
  const reached = new Promise<void>((resolve, reject) => { signalReached = resolve; rejectReached = reject; });
  const resume = new Promise<void>((resolve) => { signalResume = resolve; });
  let probeRows = -1, currentReads = 0, itemInsertStatements = 0;
  let restoreQuery: (() => void) | undefined;
  const timer = setTimeout(() => { rejectReached(new Error("commit fixture did not reach its real item probe")); signalResume(); }, 5_000);
  const acquire = vi.spyOn(pool, "getConnection").mockImplementationOnce(async () => {
    const connection = await getConnection();
    const query = connection.query.bind(connection);
    let paused = false;
    const querySpy = vi.spyOn(connection, "query").mockImplementation((async (...args: unknown[]) => {
      const statement = typeof args[0] === "string" ? args[0] : "";
      const values: unknown = args[1];
      const targeted = Array.isArray(values) && values.includes(itemId);
      if (/^\s*INSERT\s+INTO\s+items\b/i.test(statement)) itemInsertStatements += 1;
      if (targeted && /^\s*SELECT\s+item_id,\s*session_id,\s*user_id,\s*turn_id,\s*type\s+FROM\s+items\b/i.test(statement)
        && /FOR UPDATE\s*$/i.test(statement)) currentReads += 1;
      const result: unknown = await Reflect.apply(query, connection, args);
      if (!paused && targeted && /^\s*SELECT\s+item_id\s+FROM\s+items\b/i.test(statement)
        && !/FOR (?:SHARE|UPDATE)\b/i.test(statement)) {
        paused = true;
        if (!Array.isArray(result) || !Array.isArray(result[0])) throw new Error("commit fixture item probe did not return real rows");
        probeRows = result[0].length;
        clearTimeout(timer); signalReached();
        // Preserve the actual RR result, but let the independent connection commit before the
        // next real current-read query. Never fabricate rows or emulate a database write.
        await resume;
      }
      return result;
    }) as PoolConnection["query"]);
    restoreQuery = () => querySpy.mockRestore();
    return connection;
  });
  return { reached, resume: signalResume, evidence: () => ({ probeRows, currentReads, itemInsertStatements }),
    dispose() { clearTimeout(timer); signalResume(); restoreQuery?.(); acquire.mockRestore(); } };
}

function preparedBatch(session: Session, label: string, ids: { item?: string; turn?: string; approval?: string } = {}) {
  const at = Date.now();
  const turn: Turn = { id: ids.turn ?? newId("turn"), sessionId: session.id, status: "inProgress",
    seqStart: 2, steps: 0, toolCalls: 0, usage: { ...emptyUsage(), costCNY: 0 }, startedAtMs: at };
  const item: Item = { id: ids.item ?? newId("item"), sessionId: session.id, turnId: turn.id, seq: 0,
    status: "completed", createdAtMs: at, completedAtMs: at, type: "agentMessage", text: label, phase: "finalAnswer" };
  const approval: Approval = { id: ids.approval ?? newId("apr"), sessionId: session.id, turnId: turn.id,
    itemId: item.id, status: "pending", toolCallId: `fixture-${label}`, toolName: "fixture",
    args: { label }, availableDecisions: ["accept", "decline"], createdAtMs: at, expiresAtMs: at + 60_000 };
  const batch: CommitBatch = { sessionId: session.id, fence: 7, expectedLastSeq: 1, turn, items: [item], approvals: [approval],
    events: [
      { type: "turn/started", sessionId: session.id, emittedAtMs: at, turn },
      { type: "item/completed", sessionId: session.id, emittedAtMs: at, item },
      { type: "approval/requested", sessionId: session.id, emittedAtMs: at, approval },
    ], sessionPatch: { title: label, status: { type: "active", turnId: turn.id, activeFlags: [] } } };
  return { session, label, turn, item, approval, batch };
}
type Prepared = ReturnType<typeof preparedBatch>;

function outcomeSummary(outcome: PromiseSettledResult<CommitResult>) {
  if (outcome.status === "fulfilled") return { status: "fulfilled" as const };
  const reason: unknown = outcome.reason;
  const code: unknown = reason !== null && typeof reason === "object" ? (reason as { code?: unknown }).code : undefined;
  return { status: "rejected" as const,
    code: code === "ER_LOCK_DEADLOCK" || code === "ER_DUP_ENTRY" || code === "ER_LOCK_WAIT_TIMEOUT" ? code : "other" };
}

describeMysql("MysqlSessionStore independent commit concurrency", () => {
  let admin: Connection | undefined;
  let base: URL;
  let database = "";
  let created = false;
  let first: MysqlSessionStore | undefined;
  let second: MysqlSessionStore | undefined;
  let inspect: Connection | undefined;

  beforeAll(async () => {
    base = disposableBase();
    admin = await mysql.createConnection(databaseUrl(base, "mysql"));
  }, 120_000);

  beforeEach(async () => {
    database = `agent_service_test_commit_concurrency_${randomBytes(10).toString("hex")}`;
    created = false;
    if (!DATABASE_NAME.test(database) || database.length > 64) throw new Error("unsafe generated commit fixture name");
    const [existing] = await admin!.query<RowDataPacket[]>(
      "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database]);
    expect(existing).toHaveLength(0);
    // No adoption of an existing database and no cleanup after an ambiguous CREATE response.
    await admin!.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    created = true;
    const url = databaseUrl(base, database);
    first = await MysqlSessionStore.connect({ url, connectionLimit: 1 });
    second = await MysqlSessionStore.connect({ url, connectionLimit: 1 });
    inspect = await mysql.createConnection(url);
    for (const table of ["sessions", "items", "turns", "approvals", "events"] as const) {
      const [rows] = await inspect.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(Number(rows[0]?.n)).toBe(0);
    }
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    const closed = await Promise.allSettled([first?.close(), second?.close(), inspect?.end()]);
    first = undefined; second = undefined; inspect = undefined;
    // Drop only an exact random database whose CREATE this fixture acknowledged.
    if (created) {
      if (!DATABASE_NAME.test(database)) throw new Error("unsafe commit fixture cleanup target");
      if (closed.some((result) => result.status === "rejected")) throw new Error("commit fixture connection cleanup failed");
      await admin!.query(`DROP DATABASE \`${database}\``);
      created = false;
    }
  }, 120_000);
  afterAll(async () => { await admin?.end(); }, 120_000);

  async function rawSession(session: Session) {
    const [rows] = await inspect!.query<RowDataPacket[]>(
      "SELECT tenant_id,user_id,status,title,last_seq,fence_token,usage_json,updated_at_ms FROM sessions WHERE session_id=?", [session.id]);
    expect(rows).toHaveLength(1); return rows[0]!;
  }
  async function assertCommitted(h: Prepared, result: CommitResult) {
    expect(result.lastSeq).toBe(4);
    expect(result.events.map((event) => [event.type, event.seq])).toEqual([
      ["turn/started", 2], ["item/completed", 3], ["approval/requested", 4],
    ]);
    expect(h.item.seq).toBe(3);
    const row = await rawSession(h.session);
    expect(row).toMatchObject({ tenant_id: h.session.tenantId, user_id: h.session.userId, title: h.label, last_seq: 4, fence_token: 7 });
    expect(json(row.status)).toEqual({ type: "active", turnId: h.turn.id, activeFlags: [] });
    const [items] = await inspect!.query<RowDataPacket[]>("SELECT * FROM items WHERE session_id=?", [h.session.id]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ item_id: h.item.id, session_id: h.session.id, user_id: h.session.userId,
      turn_id: h.turn.id, seq: 3, type: "agentMessage", status: "completed" });
    expect(json(items[0]!.body)).toEqual(h.item);
    const [turns] = await inspect!.query<RowDataPacket[]>("SELECT * FROM turns WHERE session_id=?", [h.session.id]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ turn_id: h.turn.id, session_id: h.session.id, user_id: h.session.userId, status: "inProgress", seq_start: 2 });
    expect(json(turns[0]!.body)).toEqual(h.turn);
    const [approvals] = await inspect!.query<RowDataPacket[]>("SELECT * FROM approvals WHERE session_id=?", [h.session.id]);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ approval_id: h.approval.id, session_id: h.session.id, user_id: h.session.userId, turn_id: h.turn.id, status: "pending" });
    expect(json(approvals[0]!.body)).toEqual(h.approval);
    const [events] = await inspect!.query<RowDataPacket[]>("SELECT seq,user_id,type,body FROM events WHERE session_id=? ORDER BY seq", [h.session.id]);
    expect(events).toHaveLength(4);
    expect(events.map((event) => Number(event.seq))).toEqual([1, 2, 3, 4]);
    expect(events.every((event) => event.user_id === h.session.userId)).toBe(true);
    const parsed = events.map((event) => Event.parse(json(event.body)));
    expect(parsed[0]).toMatchObject({ type: "session/created", seq: 1, sessionId: h.session.id });
    expect(parsed.slice(1)).toEqual(result.events);
    expect(await first!.getTurn(h.session.id, h.turn.id)).toMatchObject({ id: h.turn.id, sessionId: h.session.id });
    expect(await second!.getItem(h.session.id, h.item.id)).toMatchObject({ id: h.item.id, sessionId: h.session.id, text: h.label });
    expect(await first!.getApproval(h.session.id, h.approval.id)).toEqual(h.approval);
  }

  async function concurrent(a: Prepared, b: Prepared) {
    const barrier = new FirstItemInsertBarrier();
    const restore = [interceptFirstItemInsert(first!, barrier, "first"), interceptFirstItemInsert(second!, barrier, "second")];
    try {
      const outcomes = await Promise.allSettled([first!.commit(a.batch), second!.commit(b.batch)]);
      expect([...barrier.arrivals].sort()).toEqual(["first", "second"]);
      return outcomes;
    } finally { barrier.dispose(); for (const undo of restore) undo(); }
  }

  it("commits two independent sessions after both RR transactions reach their first item INSERT without retry", async () => {
    const tenant = `tenant_commit_${randomBytes(6).toString("hex")}`;
    const a = preparedBatch(mkSession(tenant, "same-user"), "independent-a");
    const b = preparedBatch(mkSession(tenant, "same-user"), "independent-b");
    await first!.createSession(a.session); await second!.createSession(b.session);
    const outcomes = await concurrent(a, b);
    // Native InnoDB failures remain failures: no retry, fixture error suppression or SQL fake.
    expect(outcomes.map(outcomeSummary), JSON.stringify(outcomes.map(outcomeSummary)))
      .toEqual([{ status: "fulfilled" }, { status: "fulfilled" }]);
    for (const [index, h] of [a, b].entries()) {
      const outcome = outcomes[index]!;
      if (outcome.status !== "fulfilled") throw new Error("independent commit did not complete");
      await assertCommitted(h, outcome.value);
    }
    const [counts] = await inspect!.query<RowDataPacket[]>("SELECT (SELECT COUNT(*) FROM items) AS items,(SELECT COUNT(*) FROM turns) AS turns,(SELECT COUNT(*) FROM approvals) AS approvals,(SELECT COUNT(*) FROM events) AS events");
    expect(counts[0]).toMatchObject({ items: 2, turns: 2, approvals: 2, events: 8 });
  }, 30_000);

  it.each(["item", "turn", "approval"] as const)("keeps exactly one global %s owner and rolls the other session back completely", async (kind) => {
    const shared = newId(kind === "approval" ? "apr" : kind);
    const a = preparedBatch(mkSession("tenant_collision_a", "user_collision_a"), "winner-candidate-a", { [kind]: shared });
    const b = preparedBatch(mkSession("tenant_collision_b", "user_collision_b"), "winner-candidate-b", { [kind]: shared });
    await first!.createSession(a.session); await second!.createSession(b.session);
    const before = [await rawSession(a.session), await rawSession(b.session)];
    const outcomes = await concurrent(a, b);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const winningIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
    const losingIndex = winningIndex === 0 ? 1 : 0;
    const winner = [a, b][winningIndex]!, loser = [a, b][losingIndex]!;
    const outcome = outcomes[winningIndex]!;
    if (outcome.status !== "fulfilled") throw new Error("global identity collision had no winner");
    await assertCommitted(winner, outcome.value);
    expect(await rawSession(loser.session)).toEqual(before[losingIndex]);
    expect(loser.item.seq).toBe(0); expect(loser.turn.seqEnd).toBeUndefined();
    for (const table of ["items", "turns", "approvals"] as const) {
      const [rows] = await inspect!.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id=?`, [loser.session.id]);
      expect(Number(rows[0]?.n)).toBe(0);
    }
    const [losingEvents] = await inspect!.query<RowDataPacket[]>("SELECT seq,type FROM events WHERE session_id=? ORDER BY seq", [loser.session.id]);
    expect(losingEvents).toEqual([expect.objectContaining({ seq: 1, type: "session/created" })]);
    expect(await first!.getTurn(loser.session.id, winner.turn.id)).toBeNull();
    expect(await second!.getItem(loser.session.id, winner.item.id)).toBeNull();
    expect(await first!.getApproval(loser.session.id, winner.approval.id)).toBeNull();
    expect(await first!.getSession(loser.session.tenantId, winner.session.id)).toBeNull();
    const table = kind === "item" ? "items" : kind === "turn" ? "turns" : "approvals";
    const column = kind === "item" ? "item_id" : kind === "turn" ? "turn_id" : "approval_id";
    const [globalRows] = await inspect!.query<RowDataPacket[]>(`SELECT session_id,user_id FROM ${table} WHERE ${column}=?`, [shared]);
    expect(globalRows).toEqual([expect.objectContaining({ session_id: winner.session.id, user_id: winner.session.userId })]);
    const [counts] = await inspect!.query<RowDataPacket[]>("SELECT (SELECT COUNT(*) FROM items) AS items,(SELECT COUNT(*) FROM turns) AS turns,(SELECT COUNT(*) FROM approvals) AS approvals,(SELECT COUNT(*) FROM events) AS events");
    expect(counts[0]).toMatchObject({ items: 1, turns: 1, approvals: 1, events: 5 });
  }, 30_000);

  it("rechecks an event-only missing item with a current owner lock after a different owner inserts it", async () => {
    const referencing = mkSession("tenant_reference_only", "user_reference_only");
    const foreign = preparedBatch(mkSession("tenant_reference_foreign", "user_reference_foreign"), "foreign-item");
    await first!.createSession(referencing); await second!.createSession(foreign.session);
    const before = await rawSession(referencing);
    const eventItem: Item = { ...foreign.item, sessionId: referencing.id, turnId: newId("turn"), text: "reference-only" };
    const batch: CommitBatch = { sessionId: referencing.id, fence: 8, expectedLastSeq: 1,
      events: [{ type: "item/completed", sessionId: referencing.id, emittedAtMs: Date.now(), item: eventItem }] };
    expect(batch.items).toBeUndefined();
    const pause = pauseAfterRealItemProbe(first!, eventItem.id);
    const pending = first!.commit(batch);
    const settled = Promise.allSettled([pending]);
    try {
      await Promise.race([pause.reached, settled.then(() => { throw new Error("event-only commit completed before its probe pause"); })]);
      expect(pause.evidence().probeRows).toBe(0);
      const foreignResult = await second!.commit(foreign.batch);
      pause.resume();
      await expect(pending).rejects.toThrow("item identity conflicts with another session owner");
      expect(pause.evidence()).toEqual({ probeRows: 0, currentReads: 1, itemInsertStatements: 0 });
      expect(eventItem.seq).toBe(0);
      expect(await rawSession(referencing)).toEqual(before);
      const [events] = await inspect!.query<RowDataPacket[]>("SELECT seq,type FROM events WHERE session_id=? ORDER BY seq", [referencing.id]);
      expect(events).toEqual([expect.objectContaining({ seq: 1, type: "session/created" })]);
      expect(await first!.getItem(referencing.id, eventItem.id)).toBeNull();
      await assertCommitted(foreign, foreignResult);
    } finally { pause.resume(); await settled; pause.dispose(); }
  }, 30_000);

  it("rejects a previously observed ordinary item that disappears before its current identity lock without recreating it", async () => {
    const own = preparedBatch(mkSession("tenant_disappeared_item", "user_disappeared_item"), "ordinary-item");
    await first!.createSession(own.session);
    await first!.commit(own.batch);
    const before = await rawSession(own.session);
    const changed: Item = { ...own.item, text: "must-not-be-recreated" };
    const batch: CommitBatch = { sessionId: own.session.id, fence: 8, expectedLastSeq: 4, items: [changed],
      events: [{ type: "item/completed", sessionId: own.session.id, emittedAtMs: Date.now(), item: changed }],
      sessionPatch: { title: "must-not-be-published" } };
    const pause = pauseAfterRealItemProbe(first!, own.item.id);
    const pending = first!.commit(batch);
    const settled = Promise.allSettled([pending]);
    try {
      await Promise.race([pause.reached, settled.then(() => { throw new Error("ordinary commit completed before its probe pause"); })]);
      expect(pause.evidence().probeRows).toBe(1);
      // Deliberate privileged tampering in this fresh inactive-capture test database only.
      // This is not an ordinary API deletion capability. No product guard is dropped or changed.
      const [deleted] = await inspect!.query<mysql.ResultSetHeader>("DELETE FROM items WHERE item_id=? AND session_id=?", [own.item.id, own.session.id]);
      expect(deleted.affectedRows).toBe(1);
      pause.resume();
      await expect(pending).rejects.toThrow("observed item disappeared before its identity lock");
      expect(pause.evidence()).toEqual({ probeRows: 1, currentReads: 1, itemInsertStatements: 0 });
      expect(await rawSession(own.session)).toEqual(before);
      const [items] = await inspect!.query<RowDataPacket[]>("SELECT item_id FROM items WHERE item_id=?", [own.item.id]);
      expect(items).toHaveLength(0);
      const [events] = await inspect!.query<RowDataPacket[]>("SELECT seq FROM events WHERE session_id=? ORDER BY seq", [own.session.id]);
      expect(events.map((event) => Number(event.seq))).toEqual([1, 2, 3, 4]);
      expect(await second!.getItem(own.session.id, own.item.id)).toBeNull();
    } finally { pause.resume(); await settled; pause.dispose(); }
  }, 30_000);
});
