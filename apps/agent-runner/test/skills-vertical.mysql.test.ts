import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { Event, Item, ResolvedSkillContext, Turn } from "@agent-service/protocol";
import { MysqlSessionStore } from "@agent-service/store";
import { runSkillsVertical, type SkillsBeforeSecondModel } from "./fixtures/skills-vertical.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../test/fixtures/mysql-runtime.mjs";

const OWNED_DATABASE = /^agent_service_skills_vertical_test_[0-9a-f]{24}$/;
function disposableBase(): URL {
  const raw = process.env.MYSQL_TEST_URL;
  if (!raw) throw new Error("MYSQL_TEST_URL is required for the isolated skills MySQL vertical");
  try {
    const url = new URL(raw), database = decodeURIComponent(url.pathname.slice(1));
    if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !/^[A-Za-z0-9_]+$/.test(database) || !/(?:^|_)test(?:$|_)/i.test(database)
      || !url.username || url.search || url.hash) throw new Error();
    return url;
  } catch { throw new Error("MYSQL_TEST_URL must identify loopback MySQL and a test database without URL options"); }
}
function databaseUrl(base: URL, database: string): string { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); }
function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8"));
  return value;
}
function integer(value: unknown): number {
  if ((typeof value !== "number" && (typeof value !== "string" || !/^[0-9]+$/.test(value)))
    || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error("Skills fixture SQL integer is invalid.");
  return Number(value);
}
interface SessionRow extends RowDataPacket { tenant_id: string; user_id: string; last_seq: number | string; status: unknown }
interface ItemRow extends RowDataPacket { item_id: string; user_id: string; turn_id: string; seq: number | string; type: string; status: string; body: unknown }
interface TurnRow extends RowDataPacket { user_id: string; status: string; body: unknown }
interface EventRow extends RowDataPacket { user_id: string; seq: number | string; type: string; body: unknown }
type Stage = "create" | "runtime" | "before_second_commit" | "cold_connect" | "cold_read" | "cold_sql" | "close" | "cleanup";

if (process.env.AGENT_SERVICE_INTEGRATION === "1") {
  describe("static skills source bootstrap vertical with fresh isolated MySQL", () => {
    it("commits a typed skill result before model step two, then retains exact body/hash/seq through DDL-free cold reads", async () => {
      const deadlineAt = performance.now() + 60_000;
      const base = disposableBase(), database = `agent_service_skills_vertical_test_${randomBytes(12).toString("hex")}`;
      if (!OWNED_DATABASE.test(database) || database === decodeURIComponent(base.pathname.slice(1))) {
        throw new Error("Skills fixture database ownership check failed");
      }
      const mysqlUrl = databaseUrl(base, database), adminUrl = databaseUrl(base, "mysql");
      let admin: Connection | undefined, observer: Connection | undefined, cold: MysqlSessionStore | undefined;
      let runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined;
      let runtimeReleased = false;
      const operation = new AbortController();
      let createAttempted = false, created = false, dropped = false, ownedServicesClosed = false;
      let observerUncertain = false, coldUncertain = false, adminUncertain = false;
      let stage: Stage = "create", failureStage: Stage | undefined, bodyPassed = false, cleanupPassed = false;
      let beforeSecondCount = 0;
      const boundary: { beforeSecond?: { expected: SkillsBeforeSecondModel; turnId: string; context: ResolvedSkillContext } } = {};
      const failure = () => { failureStage ??= stage; };
      // Vitest's timeout does not cancel this async body. Keep a separate monotonic fence
      // across cold reads and cleanup so a late continuation can never qualify for DROP.
      let expired = false;
      const deadlineExpired = () => {
        if (performance.now() >= deadlineAt) expired = true;
        if (expired) { operation.abort(); failure(); }
        return expired;
      };
      const checkDeadline = () => { if (deadlineExpired()) throw new Error("Skills fixture deadline expired."); };
      const deadlineTimer = setTimeout(() => { expired = true; operation.abort(); failure(); }, Math.max(0, Math.ceil(deadlineAt - performance.now())));
      async function closeAdmin() {
        const connection = admin;
        if (!connection) return;
        adminUncertain = true;
        try { await connection.end(); admin = undefined; adminUncertain = false; }
        catch { connection.destroy(); throw new Error("Skills fixture admin close is uncertain."); }
      }
      async function closeObserver() {
        const connection = observer;
        if (!connection) return;
        observerUncertain = true;
        try { await connection.end(); observer = undefined; observerUncertain = false; }
        catch { connection.destroy(); throw new Error("Skills fixture observer close is uncertain."); }
      }
      /** Independent real SQL connection: visible rows here must already be committed by the
       * runner. It cannot observe an uncommitted write or be satisfied by in-process store state. */
      async function inspectCommitted(expected: SkillsBeforeSecondModel, final = false) {
        checkDeadline();
        if (observer || observerUncertain) throw new Error("Skills fixture observer ownership is uncertain.");
        observerUncertain = true;
        observer = await mysql.createConnection({ uri: mysqlUrl, connectTimeout: 5000, supportBigNumbers: true, bigNumberStrings: true });
        observerUncertain = false;
        let inTransaction = false;
        try {
          checkDeadline();
          await observer.query({ sql: "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", timeout: 5000 });
          await observer.query({ sql: "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY", timeout: 5000 });
          inTransaction = true;
          const [sessions] = await observer.query<SessionRow[]>({ sql: "SELECT tenant_id,user_id,last_seq,status FROM sessions WHERE BINARY session_id=BINARY ?", timeout: 5000 }, [expected.sessionId]);
          expect(sessions.length).toBe(1); const session = sessions[0]!;
          expect(session.tenant_id).toBe(expected.owner.tenantId); expect(session.user_id).toBe(expected.owner.userId);
          expect(parseJson(session.status)).toMatchObject({ type: final ? "idle" : "active" });
          const [turnRows] = await observer.query<TurnRow[]>({ sql: "SELECT user_id,status,body FROM turns WHERE BINARY session_id=BINARY ?", timeout: 5000 }, [expected.sessionId]);
          expect(turnRows.length).toBe(1); expect(turnRows[0]!.user_id).toBe(expected.owner.userId);
          const turn = Turn.parse(parseJson(turnRows[0]!.body));
          expect(turn.status).toBe(final ? "completed" : "inProgress"); expect(turnRows[0]!.status).toBe(turn.status);
          if (final) expect(turn).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 2, toolCalls: 1 });
          const [rows] = await observer.query<ItemRow[]>({ sql: "SELECT item_id,user_id,turn_id,seq,type,status,body FROM items WHERE BINARY session_id=BINARY ? ORDER BY seq,item_id", timeout: 5000 }, [expected.sessionId]);
          expect(rows.length).toBeGreaterThan(0);
          const items = rows.map(row => {
            const item = Item.parse(parseJson(row.body)); expect(row.user_id).toBe(expected.owner.userId);
            expect(row.turn_id).toBe(turn.id); expect(item.id).toBe(row.item_id); expect(item.seq).toBe(integer(row.seq));
            expect(item.type).toBe(row.type); expect(item.status).toBe(row.status); return item;
          });
          const calls = items.filter(item => item.type === "toolCall"), results = items.filter(item => item.type === "toolResult");
          expect(calls.length).toBe(1); expect(results.length).toBe(1);
          expect(calls[0]).toMatchObject({ name: "skill", kind: "skill", toolCallId: expected.toolCallId, status: "completed", startedAtMs: expect.any(Number) });
          const result = results[0]!;
          if (result.type !== "toolResult" || !result.details || typeof result.details !== "object") throw new Error("Skills fixture SQL result is missing.");
          expect(result).toMatchObject({ name: "skill", toolCallId: expected.toolCallId, status: "completed", isError: false });
          expect(Object.keys(result.details)).toEqual(["skillContext"]);
          const context = ResolvedSkillContext.parse((result.details as { skillContext: unknown }).skillContext);
          expect(context).toMatchObject({ id: expected.mountId, name: expected.skillName, contentSha256: expected.contentSha256, body: expected.body });
          expect(result.content.length).toBe(1); const content = result.content[0];
          if (!content || content.type !== "text") throw new Error("Skills fixture SQL content is invalid.");
          expect(content.text.includes(expected.body)).toBe(true); expect(content.text.includes(context.versionSha256)).toBe(true);
          expect(content.text.includes(expected.contentSha256)).toBe(true);
          const [eventRows] = await observer.query<EventRow[]>({ sql: "SELECT user_id,seq,type,body FROM events WHERE BINARY session_id=BINARY ? ORDER BY seq", timeout: 5000 }, [expected.sessionId]);
          const events = eventRows.map(row => {
            const event = Event.parse(parseJson(row.body)); expect(row.user_id).toBe(expected.owner.userId);
            expect(event.type).toBe(row.type); expect(event.seq).toBe(integer(row.seq)); return event;
          });
          expect(events.map(event => event.seq)).toEqual(Array.from({ length: integer(session.last_seq) }, (_, index) => index + 1));
          const resultEvents = events.filter(event => event.type === "item/completed" && event.item.id === result.id);
          expect(resultEvents.length).toBe(1); const resultEvent = resultEvents[0];
          if (resultEvent?.type !== "item/completed" || resultEvent.item.type !== "toolResult") throw new Error("Skills fixture SQL event is invalid.");
          expect(resultEvent.item.details).toEqual({ skillContext: context }); expect(resultEvent.item.content).toEqual(result.content);
          expect(integer(session.last_seq)).toBeGreaterThanOrEqual(resultEvent.seq);
          const [foreign] = await observer.query<RowDataPacket[]>({ sql: "SELECT COUNT(*) AS n FROM sessions WHERE BINARY session_id=BINARY ? AND (BINARY tenant_id=BINARY ? OR BINARY user_id=BINARY ?)", timeout: 5000 },
            [expected.sessionId, "tenant_other_skills", "trusted-caller-skills"]);
          expect(integer(foreign[0]?.n)).toBe(0);
          const [approvals] = await observer.query<RowDataPacket[]>({ sql: "SELECT COUNT(*) AS n FROM approvals WHERE BINARY session_id=BINARY ?", timeout: 5000 }, [expected.sessionId]);
          expect(integer(approvals[0]?.n)).toBe(0);
          if (!final) expect(events.some(event => event.type === "turn/completed")).toBe(false);
          else expect(events.slice(-2)).toMatchObject([{ type: "turn/completed", turn: { id: turn.id, status: "completed" } }, { type: "session/status/changed", status: { type: "idle" } }]);
          await observer.query({ sql: "ROLLBACK", timeout: 5000 }); inTransaction = false;
          checkDeadline();
          return { turnId: turn.id, context, lastSeq: integer(session.last_seq) };
        } finally {
          try { if (inTransaction) await observer.query({ sql: "ROLLBACK", timeout: 5000 }); }
          finally { await closeObserver(); }
        }
      }
      try {
        // Only /mysql is used for administrative DDL; the supplied base schema is never opened,
        // migrated, written, flushed or dropped. A lost CREATE response never grants ownership.
        adminUncertain = true;
        admin = await mysql.createConnection({ uri: adminUrl, connectTimeout: 5000 }); adminUncertain = false;
        checkDeadline();
        const [existing] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", timeout: 5000 }, [database]);
        expect(existing.length).toBe(0);
        const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: mysqlUrl,
          applicationDatabase: database, operationAbortSignal: operation.signal });
        createAttempted = true;
        checkDeadline();
        await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`, timeout: 5000 }); created = true;
        await closeAdmin();
        runtime = await prepareMysqlRuntimeFixture(witness, { schemaExecutor: options => MysqlSessionStore.runSchemaOperation(options) });
        checkDeadline(); await runtime.assertReusable(mysqlUrl); stage = "runtime";
        checkDeadline();
        const result = await runSkillsVertical({ mysqlUrl, mysqlRuntimeEnv: runtime.runtimeEnv,
          onBeforeSecondModelRequest: async expected => {
            stage = "before_second_commit"; beforeSecondCount++;
            const proof = await inspectCommitted(expected);
            checkDeadline();
            boundary.beforeSecond = { expected, turnId: proof.turnId, context: proof.context }; stage = "runtime";
          }, onOwnedServicesClosed: () => { ownedServicesClosed = true; } });
        checkDeadline();
        expect(result.profile).toBe("source-mysql-only"); expect(ownedServicesClosed).toBe(true); expect(beforeSecondCount).toBe(1);
        const beforeSecond = boundary.beforeSecond;
        expect(beforeSecond).toBeDefined(); if (!beforeSecond) throw new Error("Skills fixture did not inspect model-step boundary.");
        expect(beforeSecond.turnId).toBe(result.turnId); expect(beforeSecond.context).toEqual(result.skillContext);
        stage = "cold_connect"; coldUncertain = true;
        await runtime.assertReusable(mysqlUrl); checkDeadline();
        cold = await MysqlSessionStore.connect({ ...runtime.runtimeStoreOptions, connectionLimit: 2,
          operationAbortSignal: operation.signal }); coldUncertain = false;
        // A connect may settle after Vitest has already timed out. Own and close that late
        // pool in finally, but do not issue any cold-read assertions or promote success.
        checkDeadline();
        stage = "cold_read";
        const session = await cold.getSession(result.owner.tenantId, result.sessionId);
        expect(session).toMatchObject({ tenantId: result.owner.tenantId, userId: result.owner.userId, status: { type: "idle" }, lastSeq: result.finalSeq });
        expect(session?.autoApprovedTools).toEqual([]); expect(await cold.getSession("tenant_other_skills", result.sessionId)).toBeNull();
        expect(await cold.getTurn(result.sessionId, result.turnId)).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 2, toolCalls: 1 });
        const items = await cold.listItems(result.sessionId, { limit: 200 });
        expect(items.filter(item => item.type === "toolCall")).toEqual([expect.objectContaining({ kind: "skill", name: "skill", toolCallId: result.toolCallId, status: "completed", startedAtMs: expect.any(Number) })]);
        expect(items.filter(item => item.type === "toolResult")).toEqual([expect.objectContaining({ name: "skill", toolCallId: result.toolCallId, isError: false,
          content: [{ type: "text", text: result.toolResultText }], details: { skillContext: result.skillContext } })]);
        expect(items.filter(item => item.type === "agentMessage" && item.status === "completed" && item.text === result.finalText).length).toBe(1);
        expect(items.filter(item => item.type === "approvalRequest").length).toBe(0);
        const events = await cold.readEvents(result.sessionId, 0, 200);
        expect(events.map(event => event.seq)).toEqual(Array.from({ length: result.finalSeq }, (_, index) => index + 1));
        expect(events.some(event => event.type === "item/completed" && event.item.type === "toolResult"
          && event.item.name === "skill" && event.item.toolCallId === result.toolCallId)).toBe(true);
        expect(events.slice(-2)).toMatchObject([{ type: "turn/completed", turn: { id: result.turnId, status: "completed" } }, { type: "session/status/changed", status: { type: "idle" } }]);
        stage = "close"; coldUncertain = true; await cold.close(); cold = undefined; coldUncertain = false;
        stage = "cold_sql"; const final = await inspectCommitted(beforeSecond.expected, true);
        expect(final.context).toEqual(result.skillContext); expect(final.turnId).toBe(result.turnId); expect(final.lastSeq).toBe(result.finalSeq);
        checkDeadline();
        bodyPassed = true;
      } catch { failure(); }
      finally {
        stage = "close";
        if (cold) { coldUncertain = true;
          try { await cold.close(); cold = undefined; coldUncertain = false; } catch { failure(); } }
        try { await closeObserver(); } catch { failure(); }
        try { await closeAdmin(); } catch { failure(); }
        if (runtime) {
          const successful = !deadlineExpired() && bodyPassed && !failureStage && ownedServicesClosed
            && !cold && !coldUncertain && !observer && !observerUncertain && !admin && !adminUncertain;
          try { await runtime.close({ successful }); runtimeReleased = successful; } catch { failure(); }
        }
        stage = "cleanup";
        const cleanupExpired = deadlineExpired();
        if (!cleanupExpired && created && bodyPassed && !failureStage && runtimeReleased && ownedServicesClosed && !cold && !coldUncertain && !observer && !observerUncertain && !admin && !adminUncertain) {
          try {
            // A new inspector, after every fixture writer/pool/observer has settled. Never KILL
            // connections, and never DROP on failed assertions or any ambiguous cleanup state.
            adminUncertain = true;
            admin = await mysql.createConnection({ uri: adminUrl, connectTimeout: 5000 }); adminUncertain = false;
            checkDeadline();
            const [connections] = await admin.query<RowDataPacket[]>({ sql: "SELECT ID FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND (BINARY DB=BINARY ? OR LOCATE(?,COALESCE(INFO,''))>0)", timeout: 5000 }, [database, database]);
            expect(connections.length).toBe(0);
            if (!OWNED_DATABASE.test(database) || database === decodeURIComponent(base.pathname.slice(1))) throw new Error("Skills fixture DROP ownership check failed");
            checkDeadline();
            await admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5000 });
            const [remaining] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", timeout: 5000 }, [database]);
            expect(remaining.length).toBe(0); dropped = true;
          } catch { failure(); }
          finally { try { await closeAdmin(); } catch { failure(); } }
        }
        cleanupPassed = !deadlineExpired() && created && dropped && !admin && !adminUncertain && !observer && !observerUncertain && !cold && !coldUncertain && ownedServicesClosed;
        if (created && !cleanupPassed || createAttempted && !created) failure();
        clearTimeout(deadlineTimer);
      }
      if (!bodyPassed || !cleanupPassed || failureStage) {
        // Only closed stage and exact owned random database name are diagnostic. No URL,
        // password, headers, native SQL error or document content is echoed into Vitest output.
        throw new Error(`Static skills MySQL vertical failed at ${failureStage ?? stage}; owned fixture ${dropped ? "dropped" : "retained if present"}: ${database}`);
      }
    }, 60_000);
  });
} else {
  describe("static skills source bootstrap vertical with fresh isolated MySQL", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 and MYSQL_TEST_URL for the fresh real MySQL vertical", () => {});
  });
}
