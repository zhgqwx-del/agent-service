import { randomUUID } from "node:crypto";
import mysql, { type Connection, type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyUsageAccumulator, type Turn } from "@agent-service/protocol";
import { MysqlSessionStore } from "../src/mysql/store.js";
import { newUsageId } from "../src/index.js";
import { SubjectDeletingError, newErasureRequestId, userErasureRequestHash } from "../src/subject-lifecycle.js";
import type { MysqlSubagentPort } from "../src/mysql/subagents.js";
import * as A from "../src/subagents.js";
import { subagentFixture, subagentProviderInput, subagentTaskRequest, subagentUsageBatch } from "./fixtures/subagents.js";
import { mkSession, newId } from "./conformance.js";

function fail(): never { throw new Error("Subagent isolated MySQL fixture is not proven."); }
function target(database: string) {
  const url = new URL(process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test");
  if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(url.pathname.slice(1)))) fail();
  url.pathname = `/${database}`; return url.toString();
}
describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("subagent actual MySQL single-root transactions", () => {
  let admin: Connection | undefined, observer: Connection | undefined, first: MysqlSessionStore | undefined, second: MysqlSessionStore | undefined;
  let database = "", uuid = "", adminId = 0, created = false, ready = false;
  beforeAll(async () => {
    admin = await mysql.createConnection(target("mysql"));
    const [identity] = await admin.query<RowDataPacket[]>("SELECT @@server_uuid AS uuid,CONNECTION_ID() AS id,DATABASE() AS db");
    uuid = String(identity[0]?.uuid).toLowerCase(); adminId = Number(identity[0]?.id);
    if (identity.length !== 1 || !/^[a-f0-9-]{36}$/.test(uuid) || !Number.isSafeInteger(adminId) || adminId < 1 || identity[0]?.db !== "mysql") fail();
    database = `agent_service_subagents_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const [existing] = await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [database]); if (existing.length) fail();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`); created = true;
    first = await MysqlSessionStore.connect({ url: target(database), connectionLimit: 4 });
    second = await MysqlSessionStore.connect({ url: target(database), migrationMode: "verify", connectionLimit: 4 });
    observer = await mysql.createConnection(target(database));
    const [actual] = await observer.query<RowDataPacket[]>("SELECT @@server_uuid AS uuid,DATABASE() AS db");
    if (actual.length !== 1 || String(actual[0]?.uuid).toLowerCase() !== uuid || actual[0]?.db !== database) fail(); ready = true;
  }, 120_000);
  afterAll(async ({}, suite) => {
    const deadline = performance.now() + 120_000;
    const passed = ready && suite.tasks.length === 12 && suite.tasks.every(test => test.type === "test" && test.mode === "run" && test.result?.state === "pass"
      && !test.result.errors?.length && (test.result.retryCount ?? 0) === 0 && (test.result.repeatCount ?? 0) === 0 && typeof test.result.duration === "number" && test.result.duration <= 30_000);
    let removed = false;
    try {
      const settled = await Promise.allSettled([first?.close(), second?.close(), observer?.end()]); if (settled.some(result => result.status !== "fulfilled")) fail();
      if (created && passed) {
        if (!admin || !/^agent_service_subagents_test_[0-9]+_[a-f0-9]{12}$/.test(database)) fail();
        const query = async (sql: string, parameters: string[] = []) => {
          const remaining = Math.floor(deadline - performance.now()); if (remaining <= 0) return fail();
          const [rows] = await admin!.query<RowDataPacket[]>({ sql, timeout: remaining }, parameters); if (performance.now() >= deadline) return fail(); return rows;
        };
        const identity = await query("SELECT @@server_uuid AS uuid,CONNECTION_ID() AS id,DATABASE() AS db");
        if (identity.length !== 1 || String(identity[0]?.uuid).toLowerCase() !== uuid || Number(identity[0]?.id) !== adminId || identity[0]?.db !== "mysql") fail();
        for (;;) {
          const refs = [await query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?", [database]),
            await query("SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?", [database]),
            await query("SELECT COUNT(*) AS n FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ? OR (OBJECT_TYPE='SCHEMA' AND BINARY OBJECT_NAME=BINARY ?)", [database, database])];
          const counts = refs.map(rows => rows.length === 1 ? Number(rows[0]?.n) : Number.NaN);
          if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) fail(); if (counts.every(count => count === 0)) break;
          if (performance.now() >= deadline) fail(); await new Promise(resolve => setTimeout(resolve, 10));
        }
        if ((await query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [database])).length !== 1) fail();
        await admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: Math.max(1, Math.floor(deadline - performance.now())) });
        if ((await query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [database])).length) fail(); removed = true;
      }
    } finally {
      if (created && !removed) console.warn(JSON.stringify({ schema: "subagent-fixture-cleanup-v1", status: "retained_or_unknown", database }));
      await admin?.end();
    }
  }, 120_000);
  function stores() { if (!first || !second || !observer) return fail(); return { first, second, observer }; }
  it("ordinary commits establish their usage read view only after the prior writer releases its real session lock", async () => {
    const { first, second, observer } = stores(), at = Date.now(), session = { ...mkSession(`ordinary-subagent-${randomUUID()}`, "owner"), usage: emptyUsageAccumulator() };
    await first.createSession(session);
    const turn: Turn = { id: newId("turn"), sessionId: session.id, status: "inProgress", seqStart: 2, steps: 0, toolCalls: 0,
      model: { provider: "fixture-provider", model: "fixture-model" }, usage: emptyUsageAccumulator(), startedAtMs: at };
    await first.commit({ sessionId: session.id, fence: 1, turn, sessionPatch: { status: { type: "active", turnId: turn.id, activeFlags: [] } },
      events: [{ type: "turn/started", sessionId: session.id, turn, emittedAtMs: at }] });
    let release!: () => void, inserted!: () => void, rejectInserted!: (error: Error) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const insertion = new Promise<void>((resolve, reject) => { inserted = resolve; rejectInserted = reject; });
    const timer = setTimeout(() => { rejectInserted(new Error("Real ordinary ledger INSERT was not reached.")); release(); }, 5_000);
    const firstPool = Reflect.get(first, "pool") as Pool, secondPool = Reflect.get(second, "pool") as Pool;
    const firstAcquire = firstPool.getConnection.bind(firstPool), secondAcquire = secondPool.getConnection.bind(secondPool);
    let restoreFirst: (() => void) | undefined, waiterId = 0;
    const firstSpy = vi.spyOn(firstPool, "getConnection").mockImplementationOnce(async () => {
      const conn = await firstAcquire(), query = conn.query.bind(conn); let paused = false;
      const spy = vi.spyOn(conn, "query").mockImplementation((async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(query, conn, args);
        if (!paused && typeof args[0] === "string" && /^\s*INSERT INTO usage_ledger\b/.test(args[0])) { paused = true; clearTimeout(timer); inserted(); await gate; }
        return result;
      }) as PoolConnection["query"]); restoreFirst = () => spy.mockRestore(); return conn;
    });
    const secondSpy = vi.spyOn(secondPool, "getConnection").mockImplementationOnce(async () => {
      const conn = await secondAcquire(); const [identity] = await conn.query<RowDataPacket[]>("SELECT CONNECTION_ID() AS id");
      waiterId = Number(identity[0]?.id); if (!Number.isSafeInteger(waiterId) || waiterId < 1) return fail(); return conn;
    });
    const usage = { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 5, costCNY: 0.25 };
    const winning = first.commit({ sessionId: session.id, fence: 1, usageEntries: [{ usageId: newUsageId(), turnId: turn.id, step: 1,
      provider: "fixture-provider", model: "fixture-model", usage, createdAtMs: at }] });
    const winningSettled = Promise.allSettled([winning]); let waitingSettled: Promise<unknown> | undefined;
    try {
      await Promise.race([insertion, winning.then(() => { throw new Error("Ordinary writer did not pause after its real INSERT."); })]);
      const waiting = second.commit({ sessionId: session.id, fence: 1, turn: { ...turn, steps: 1 }, sessionPatch: { title: "after-prior-usage" } });
      waitingSettled = Promise.allSettled([waiting]);
      const deadline = performance.now() + 5_000;
      for (;;) {
        const [locks] = await observer.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w
          JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_ID=?`, [waiterId]);
        if (waiterId > 0 && Number(locks[0]?.n) > 0) break;
        if (performance.now() >= deadline) throw new Error("Independent ordinary writer did not actually wait on InnoDB.");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const [uncommitted] = await observer.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM usage_ledger WHERE session_id=?", [session.id]);
      expect(Number(uncommitted[0]?.n)).toBe(0); release(); await winning; await waiting;
      const [rawSession] = await observer.query<RowDataPacket[]>("SELECT usage_json FROM sessions WHERE session_id=?", [session.id]);
      const [rawTurn] = await observer.query<RowDataPacket[]>("SELECT body FROM turns WHERE turn_id=?", [turn.id]);
      const json = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) : value;
      expect(json(rawSession[0]?.usage_json)).toEqual(usage); expect(json(rawTurn[0]?.body)).toMatchObject({ usage });
    } finally {
      clearTimeout(timer); release(); await winningSettled; await waitingSettled; restoreFirst?.(); firstSpy.mockRestore(); secondSpy.mockRestore();
    }
  });
  it("commits real child seq1, initial turn and parent activity visible from an independent client", async () => {
    const { first, second, observer } = stores(), f = await subagentFixture(first), request = await subagentTaskRequest(f), result = await first.createSubagentTask(request.input);
    expect(await second.getSession(f.principal.tenantId, result.childSession.id)).toMatchObject({ parentSessionId: f.session.id, fenceToken: 1, lastSeq: 3 });
    expect((await second.readEvents(result.childSession.id, 0, 100)).map(event => event.seq)).toEqual([1, 2, 3]);
    const [rows] = await observer.query<RowDataPacket[]>("SELECT status,record_json FROM subagent_tasks WHERE task_id=?", [result.task.taskId]);
    expect(rows).toHaveLength(1); expect(rows[0]?.status).toBe("reserved");
    expect((await second.getSubagentRoot({ access: f.access }))?.taskCount).toBe(1);
  });
  it("serializes two clients root/child provider admission without an independent child lease", async () => {
    const { first, second } = stores(), f = await subagentFixture(first, { maxSteps: 1 }), request = await subagentTaskRequest(f), child = await first.createSubagentTask(request.input);
    const access = A.createSubagentChildAccess(f.access, { taskId: child.task.taskId, childSessionId: child.childSession.id, childTurnId: child.childTurn.id });
    const decisions = await Promise.all([first.admitSubagentBudget(subagentProviderInput(f)), second.admitSubagentBudget(subagentProviderInput(f, access))]);
    expect(decisions.filter(decision => decision.admitted)).toHaveLength(1); expect(decisions.filter(decision => !decision.admitted)[0]?.reason).toBe("max_steps");
    expect((await first.getSubagentRoot({ access: f.access }))?.steps).toBe(1);
  });
  it("rolls back prior child INSERT/event/turn and domain counters after a real late SQL failure", async () => {
    const { first, second, observer } = stores(), f = await subagentFixture(first), request = await subagentTaskRequest(f), root = await first.getSubagentRoot({ access: f.access }), head = await first.getSession(f.principal.tenantId, f.session.id);
    const trigger = `trg_subagent_test_failure_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await observer.query(`CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON items FOR EACH ROW BEGIN IF BINARY NEW.item_id=BINARY '${request.activity.id}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='controlled subagent test failure'; END IF; END`);
    try { await expect(first.createSubagentTask(request.input)).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION", errno: 1644, sqlMessage: "controlled subagent test failure" }); }
    finally { await observer.query(`DROP TRIGGER \`${trigger}\``); }
    expect(await second.getSession(f.principal.tenantId, request.session.id)).toBeNull(); expect(await second.readEvents(request.session.id, 0, 100)).toEqual([]);
    expect(await second.getTurn(request.session.id, request.turn.id)).toBeNull(); expect(await second.getSession(f.principal.tenantId, f.session.id)).toEqual(head);
    expect(await second.getSubagentRoot({ access: f.access })).toEqual(root);
    const [rows] = await observer.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM subagent_tasks WHERE task_id=?", [request.input.taskId]); expect(Number(rows[0]?.n)).toBe(0);
  });
  it("replays the same backfilled request across clients without creating another child", async () => {
    const { first, second } = stores(), f = await subagentFixture(first), request = await subagentTaskRequest(f), result = await first.createSubagentTask(request.input), head = await second.getSession(f.principal.tenantId, f.session.id);
    const replay = await second.createSubagentTask(request.input); expect(replay.replayed).toBe(true); expect(replay.task.taskId).toBe(result.task.taskId);
    expect(replay.childCommit.events).toEqual([]); expect(await second.getSession(f.principal.tenantId, f.session.id)).toEqual(head);
    await expect(second.createSubagentTask({ ...request.input, taskId: newId("sat") })).rejects.toThrow(A.SubagentConflictError);
  });
  it("native old writers cannot bypass controlled child fence or started-call admission", async () => {
    const { first, second, observer } = stores(), f = await subagentFixture(first), request = await subagentTaskRequest(f), child = await first.createSubagentTask(request.input);
    await expect(observer.query("UPDATE sessions SET title='unadmitted' WHERE session_id=?", [child.childSession.id])).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION", errno: 1644, sqlMessage: "Subagent root writer admission is required" });
    await expect(second.commit({ sessionId: child.childSession.id, fence: 2, fenceClaim: f.principal })).rejects.toThrow(A.SubagentManagedSessionError);
    expect(await second.getSession(f.principal.tenantId, child.childSession.id)).toMatchObject({ fenceToken: 1 });
  });
  it("settles one real child usage/billing fact and cold-verifies the family projection", async () => {
    const { first, second, observer } = stores(), f = await subagentFixture(first), request = await subagentTaskRequest(f), child = await first.createSubagentTask(request.input);
    const access = A.createSubagentChildAccess(f.access, { taskId: child.task.taskId, childSessionId: child.childSession.id, childTurnId: child.childTurn.id });
    await second.admitSubagentBudget(subagentProviderInput(f, access)); const batch = subagentUsageBatch(f, child.childSession.id, child.childTurn.id, 1, 0.25);
    await first.commit(A.attachSubagentCommitAdmission(batch, { access }));
    const [ledger] = await observer.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM usage_ledger WHERE session_id=?", [child.childSession.id]); expect(Number(ledger[0]?.n)).toBe(1);
    const [billing] = await observer.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM billing_usage_facts WHERE usage_id=?", [batch.usageEntries?.[0]?.usageId]); expect(Number(billing[0]?.n)).toBe(1);
    const cold = await MysqlSessionStore.connect({ url: target(database), migrationMode: "verify", connectionLimit: 1 });
    try { expect((await cold.getSubagentRoot({ access: f.access }))?.familyUsage.costCNY).toBe(0.25); } finally { await cold.close(); }
  });
  it("root fence takeover preserves unknown reservations and repairs actual terminal child state", async () => {
    const { first, second } = stores(), f = await subagentFixture(first), request = await subagentTaskRequest(f), child = await first.createSubagentTask(request.input);
    const access = A.createSubagentChildAccess(f.access, { taskId: child.task.taskId, childSessionId: child.childSession.id, childTurnId: child.childTurn.id });
    await first.admitSubagentBudget(subagentProviderInput(f, access));
    await first.commit(A.attachSubagentCommitAdmission(subagentUsageBatch(f, child.childSession.id, child.childTurn.id, 1, 0.25), { access }));
    await first.admitSubagentBudget(subagentProviderInput(f, access, 2));
    const canonical = await second.getTurn(child.childSession.id, child.childTurn.id); if (!canonical) return fail();
    expect(canonical.usage.totalTokens).toBe(5);
    await second.commit({ sessionId: f.session.id, fence: 2, fenceClaim: f.principal });
    await expect(first.admitSubagentBudget(subagentProviderInput(f, access, 2))).rejects.toThrow(A.SubagentConflictError);
    const tasks = await second.repairSubagentRoot({ principal: f.principal, rootSessionId: f.session.id, rootTurnId: f.turn.id, newFence: 2 });
    expect(tasks[0]).toMatchObject({ status: "outcome_unknown", childUsage: canonical.usage });
    expect(await first.getTurn(child.childSession.id, child.childTurn.id)).toMatchObject({ status: "interrupted", usage: canonical.usage });
    expect(await first.getItem(f.session.id, request.activity.id)).toMatchObject({ taskStatus: "outcome_unknown", childUsage: canonical.usage });
  });
  it("does not reveal membership to another actual owner or accept cloned authority", async () => {
    const { first, second } = stores(), f = await subagentFixture(first), request = await subagentTaskRequest(f), child = await first.createSubagentTask(request.input);
    expect(await second.getSubagentSessionMember({ principal: { ...f.principal, userId: "other" }, sessionId: child.childSession.id })).toBeNull();
    expect(await second.getSubagentTask({ principal: { ...f.principal, tenantId: "other" }, rootSessionId: f.session.id, taskId: child.task.taskId })).toBeNull();
    await expect(second.admitSubagentBudget({ ...subagentProviderInput(f), access: structuredClone(f.access) })).rejects.toThrow(A.SubagentIntegrityError);
  });
  it("ordinary, missing and foreign membership reads do not invoke a lifecycle writer or create subject rows", async () => {
    const { first, second, observer } = stores(), absent = { tenantId: `membership-absent-${randomUUID()}`, userId: "owner" };
    expect(await second.getSubagentSessionMember({ principal: absent, sessionId: newId("sess") })).toBeNull();
    const [subjects] = await observer.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM subject_lifecycle WHERE tenant_id=?", [absent.tenantId]);expect(Number(subjects[0]?.n)).toBe(0);
    const f = await subagentFixture(first), request = await subagentTaskRequest(f), child = await first.createSubagentTask(request.input);
    const port = Reflect.get(Reflect.get(first, "subagentDomain"), "port") as MysqlSubagentPort, gate = vi.spyOn(port, "gate");
    try {
      expect(await first.getSubagentSessionMember({ principal: f.principal, sessionId: f.session.id })).toBeNull();
      expect(await first.getSubagentSessionMember({ principal: f.principal, sessionId: newId("sess") })).toBeNull();
      expect(await first.getSubagentSessionMember({ principal: { ...f.principal, userId: "other" }, sessionId: child.childSession.id })).toBeNull();
      expect(gate).not.toHaveBeenCalled();
      expect(await first.getSubagentSessionMember({ principal: f.principal, sessionId: child.childSession.id })).toEqual({ rootSessionId: f.session.id, rootTurnId: f.turn.id, taskId: child.task.taskId });
      expect(gate).toHaveBeenCalledTimes(1);
    } finally { gate.mockRestore(); }
  });
  it("a real user erasure hides managed and ordinary lookup without changing durable state or creation and budget gates", async () => {
    const { first, second, observer } = stores(), f = await subagentFixture(first), request = await subagentTaskRequest(f), child = await first.createSubagentTask(request.input);
    const erased = await first.requestUserErasure({ requestId: newErasureRequestId(), ...f.principal, requestedByKeyId: "admin-key", idempotencyKey: "membership-hidden",
      requestHash: userErasureRequestHash(f.principal.tenantId, f.principal.userId), atMs: Date.now() });expect(erased.status).toBe("gated");
    const state = async () => {
      const [sessions] = await observer.query<RowDataPacket[]>("SELECT * FROM sessions WHERE session_id IN (?,?) ORDER BY session_id", [f.session.id, child.childSession.id]);
      const [items] = await observer.query<RowDataPacket[]>("SELECT * FROM items WHERE session_id IN (?,?) ORDER BY item_id", [f.session.id, child.childSession.id]);
      const [subjects] = await observer.query<RowDataPacket[]>("SELECT * FROM subject_lifecycle WHERE tenant_id=? ORDER BY subject_kind,subject_id", [f.principal.tenantId]);
      const [ledger] = await observer.query<RowDataPacket[]>("SELECT * FROM usage_ledger WHERE session_id IN (?,?) ORDER BY id", [f.session.id, child.childSession.id]);
      return { sessions, items, subjects, ledger };
    };
    const before = await state();expect(before.subjects.some(row=>row.subject_kind==="user"&&row.subject_id===f.principal.userId&&row.state==="deleting")).toBe(true);
    expect(await second.getSubagentSessionMember({ principal: f.principal, sessionId: f.session.id })).toBeNull();
    expect(await second.getSubagentSessionMember({ principal: f.principal, sessionId: child.childSession.id })).toBeNull();
    expect(await state()).toEqual(before);
    await expect(second.createSession(mkSession(f.principal.tenantId, f.principal.userId))).rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(second.admitSubagentBudget(subagentProviderInput(f))).rejects.toBeInstanceOf(SubjectDeletingError);
  });
  it("propagates real SQL, integrity and merely named lifecycle errors from exact managed lookup", async () => {
    const { first, observer } = stores(), f = await subagentFixture(first), request = await subagentTaskRequest(f), child = await first.createSubagentTask(request.input);
    let native: unknown;
    try { await observer.query("SELECT subagent_membership_nonexistent_column FROM subagent_tasks LIMIT 0"); } catch (error) { native = error; }
    expect(native).toMatchObject({ code: "ER_BAD_FIELD_ERROR", errno: 1054 });
    const port = Reflect.get(Reflect.get(first, "subagentDomain"), "port") as MysqlSubagentPort, gate = vi.spyOn(port, "gate");
    try {
      for (const error of [native, new A.SubagentIntegrityError(), Object.assign(new Error("not the lifecycle class"), { name: "SubjectDeletingError" })]) {
        gate.mockRejectedValueOnce(error);
        await expect(first.getSubagentSessionMember({ principal: f.principal, sessionId: child.childSession.id })).rejects.toBe(error);
      }
    } finally { gate.mockRestore(); }
  });
});
