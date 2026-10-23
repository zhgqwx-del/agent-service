import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { Approval, Event, Item, Turn, type PersistedEvent } from "@agent-service/protocol";
import { MysqlSessionStore } from "@agent-service/store";
import { runHooksVertical, type HooksBeforePostAck, type HooksVerticalResult } from "./fixtures/hooks-vertical.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../test/fixtures/mysql-runtime.mjs";
import { createSourceAuthorityExecutor } from "./fixtures/mysql-authority.js";

const OWNED_DATABASE = /^agent_service_hooks_vertical_test_[0-9a-f]{24}$/;
function disposableBase(): URL {
  const raw = process.env.MYSQL_TEST_URL;
  if (!raw) throw new Error("MYSQL_TEST_URL is required for the isolated hooks MySQL vertical");
  try {
    const url = new URL(raw), database = decodeURIComponent(url.pathname.slice(1));
    if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !/^[A-Za-z0-9_]+$/.test(database) || !/(?:^|_)test(?:$|_)/i.test(database)
      || !url.username || url.href.includes("?") || url.href.includes("#")) throw new Error();
    return url;
  } catch { throw new Error("MYSQL_TEST_URL must identify loopback MySQL and a test database without URL options"); }
}
function databaseUrl(base: URL, database: string) { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); }
function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8")); return value;
}
function integer(value: unknown): number {
  if ((typeof value !== "number" && (typeof value !== "string" || !/^[0-9]+$/.test(value)))
    || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error("Hooks fixture SQL integer is invalid.");
  return Number(value);
}
interface SessionRow extends RowDataPacket { tenant_id: string; user_id: string; last_seq: number | string; status: unknown; auto_approved_tools: unknown }
interface ItemRow extends RowDataPacket { item_id: string; user_id: string; turn_id: string; seq: number | string; type: string; status: string; body: unknown }
interface TurnRow extends RowDataPacket { turn_id: string; user_id: string; status: string; body: unknown }
interface EventRow extends RowDataPacket { user_id: string; seq: number | string; type: string; body: unknown }
interface ApprovalRow extends RowDataPacket { approval_id: string; user_id: string; turn_id: string; status: string; body: unknown }
type Stage = "create" | "runtime" | "before_post_ack" | "cold_connect" | "cold_read" | "cold_sql" | "close" | "cleanup";

function finalFacts(result: HooksVerticalResult, items: readonly Item[], events: readonly PersistedEvent[], turns: readonly Turn[], approvals: readonly Approval[]) {
  expect(turns.length).toBe(2);
  expect(new Set(turns.map(turn => turn.id))).toEqual(new Set([result.firstTurnId, result.secondTurnId]));
  for (const turn of turns) expect(turn).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 2, toolCalls: 1 });
  const calls = items.filter(item => item.type === "toolCall"), results = items.filter(item => item.type === "toolResult");
  expect(calls.length).toBe(2); expect(results.length).toBe(2);
  expect(calls.find(call => call.toolCallId === result.allowedToolCallId)).toMatchObject({ name: result.toolName, kind: "mcp",
    status: "completed", turnId: result.firstTurnId, startedAtMs: expect.any(Number) });
  const deniedCall = calls.find(call => call.toolCallId === result.deniedToolCallId);
  expect(deniedCall).toMatchObject({ name: result.toolName, kind: "mcp", status: "failed", turnId: result.secondTurnId });
  expect(deniedCall?.startedAtMs === undefined).toBe(true);
  expect(results.find(value => value.toolCallId === result.allowedToolCallId)).toMatchObject({ name: result.toolName, status: "completed",
    turnId: result.firstTurnId, isError: false, content: [{ type: "text", text: result.resultText }] });
  expect(results.find(value => value.toolCallId === result.deniedToolCallId)).toMatchObject({ name: result.toolName, status: "failed",
    turnId: result.secondTurnId, isError: true, content: [{ type: "text", text: result.deniedResultText }] });
  expect(approvals.length).toBe(1); expect(approvals[0]).toMatchObject({ id: result.approvalId, turnId: result.firstTurnId,
    status: "resolved", decision: "acceptForSession", toolCallId: result.allowedToolCallId });
  expect(items.filter(item => item.type === "approvalRequest").length).toBe(1);
  for (const text of result.finalMessages) expect(items.filter(item => item.type === "agentMessage" && item.status === "completed" && item.text === text).length).toBe(1);
  expect(events.map(event => event.seq)).toEqual(Array.from({ length: result.finalSeq }, (_, index) => index + 1));
  expect(events.filter(event => event.type === "hook/completed")).toEqual(result.hookEvents);
  expect(result.hookEvents.map(event => [event.phase, event.outcome, event.toolCallId])).toEqual([
    ["preToolUse", "allowed", result.allowedToolCallId], ["postToolUse", "acknowledged", result.allowedToolCallId],
    ["preToolUse", "denied", result.deniedToolCallId] ]);
  expect(events.filter(event => event.type === "approval/requested").length).toBe(1);
  expect(events.slice(-2)).toMatchObject([{ type: "turn/completed", turn: { id: result.secondTurnId, status: "completed" } },
    { type: "session/status/changed", status: { type: "idle" } }]);
  for (const item of items) expect(item.sessionId).toBe(result.sessionId);
  for (const event of events) expect(event.sessionId).toBe(result.sessionId);
}

if (process.env.AGENT_SERVICE_INTEGRATION === "1") {
  describe("tool hooks real source bootstrap vertical with fresh isolated MySQL", () => {
    it("sees canonical result and resumed grant before post ACK, then retains hook seq/owner through DDL-free cold reads", async () => {
      const deadlineAt = performance.now() + 60_000;
      const base = disposableBase(), database = `agent_service_hooks_vertical_test_${randomBytes(12).toString("hex")}`;
      if (!OWNED_DATABASE.test(database) || database === decodeURIComponent(base.pathname.slice(1))) throw new Error("Hooks fixture database ownership check failed");
      const mysqlUrl = databaseUrl(base, database), adminUrl = databaseUrl(base, "mysql");
      let admin: Connection | undefined, observer: Connection | undefined, cold: MysqlSessionStore | undefined;
      let runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined;
      let runtimeReleased = false;
      const operation = new AbortController();
      let createAttempted = false, created = false, dropped = false, ownedServicesClosed = false;
      let observerUncertain = false, coldUncertain = false, adminUncertain = false;
      let stage: Stage = "create", failureStage: Stage | undefined, bodyPassed = false, cleanupPassed = false, expired = false;
      let postCount = 0;
      const boundary: { post?: HooksBeforePostAck; completed: boolean } = { completed: false };
      const failure = () => { failureStage ??= stage; };
      // Vitest timeout does not cancel async work: actual monotonic expiry permanently revokes
      // success/DROP eligibility, including a cold connection that settles after the test failed.
      const deadlineExpired = () => { if (performance.now() >= deadlineAt) expired = true; if (expired) { operation.abort(); failure(); } return expired; };
      const checkDeadline = () => { if (deadlineExpired()) throw new Error("Hooks fixture deadline expired."); };
      const timer = setTimeout(() => { expired = true; operation.abort(); failure(); }, Math.max(0, Math.ceil(deadlineAt - performance.now())));
      async function closeAdmin() {
        const connection = admin; if (!connection) return; adminUncertain = true;
        try { await connection.end(); admin = undefined; adminUncertain = false; }
        catch { connection.destroy(); throw new Error("Hooks fixture admin close is uncertain."); }
      }
      async function closeObserver() {
        const connection = observer; if (!connection) return; observerUncertain = true;
        try { await connection.end(); observer = undefined; observerUncertain = false; }
        catch { connection.destroy(); throw new Error("Hooks fixture observer close is uncertain."); }
      }
      /** A separate native connection and a real RR read-only snapshot, not the runner pool or
       * its in-memory state. In the first invocation the remote post ACK has not been sent yet. */
      async function inspectCommitted(expected: HooksBeforePostAck, final?: HooksVerticalResult) {
        checkDeadline(); if (observer || observerUncertain) throw new Error("Hooks fixture observer ownership is uncertain.");
        observerUncertain = true;
        observer = await mysql.createConnection({ uri: mysqlUrl, connectTimeout: 5000, supportBigNumbers: true, bigNumberStrings: true });
        observerUncertain = false; let inTransaction = false;
        try {
          checkDeadline();
          await observer.query({ sql: "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", timeout: 5000 });
          await observer.query({ sql: "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY", timeout: 5000 }); inTransaction = true;
          const [sessions] = await observer.query<SessionRow[]>({ sql: "SELECT tenant_id,user_id,last_seq,status,auto_approved_tools FROM sessions WHERE BINARY session_id=BINARY ?", timeout: 5000 }, [expected.sessionId]);
          expect(sessions.length).toBe(1); const session = sessions[0]!;
          expect(session.tenant_id).toBe(expected.owner.tenantId); expect(session.user_id).toBe(expected.owner.userId);
          expect(parseJson(session.status)).toMatchObject({ type: final ? "idle" : "active" });
          expect(parseJson(session.auto_approved_tools)).toEqual([expected.approvalScope]);
          const [turnRows] = await observer.query<TurnRow[]>({ sql: "SELECT turn_id,user_id,status,body FROM turns WHERE BINARY session_id=BINARY ? ORDER BY turn_id", timeout: 5000 }, [expected.sessionId]);
          const turns = turnRows.map(row => { const turn = Turn.parse(parseJson(row.body)); expect(row.user_id).toBe(expected.owner.userId);
            expect(turn.id).toBe(row.turn_id); expect(turn.status).toBe(row.status); expect(turn.sessionId).toBe(expected.sessionId); return turn; });
          const [itemRows] = await observer.query<ItemRow[]>({ sql: "SELECT item_id,user_id,turn_id,seq,type,status,body FROM items WHERE BINARY session_id=BINARY ? ORDER BY seq,item_id", timeout: 5000 }, [expected.sessionId]);
          const items = itemRows.map(row => { const item = Item.parse(parseJson(row.body)); expect(row.user_id).toBe(expected.owner.userId);
            expect(item.id).toBe(row.item_id); expect(item.turnId).toBe(row.turn_id); expect(item.sessionId).toBe(expected.sessionId);
            expect(item.seq).toBe(integer(row.seq)); expect(item.type).toBe(row.type); expect(item.status).toBe(row.status); return item; });
          const [eventRows] = await observer.query<EventRow[]>({ sql: "SELECT user_id,seq,type,body FROM events WHERE BINARY session_id=BINARY ? ORDER BY seq", timeout: 5000 }, [expected.sessionId]);
          const events = eventRows.map(row => { const event = Event.parse(parseJson(row.body)); expect(row.user_id).toBe(expected.owner.userId);
            expect(event.sessionId).toBe(expected.sessionId); expect(event.type).toBe(row.type); expect(event.seq).toBe(integer(row.seq));
            if (typeof event.seq !== "number") throw new Error("Hooks fixture SQL event is not persisted."); return event as PersistedEvent; });
          expect(events.map(event => event.seq)).toEqual(Array.from({ length: integer(session.last_seq) }, (_, index) => index + 1));
          const [approvalRows] = await observer.query<ApprovalRow[]>({ sql: "SELECT approval_id,user_id,turn_id,status,body FROM approvals WHERE BINARY session_id=BINARY ? ORDER BY approval_id", timeout: 5000 }, [expected.sessionId]);
          const approvals = approvalRows.map(row => { const approval = Approval.parse(parseJson(row.body)); expect(row.user_id).toBe(expected.owner.userId);
            expect(approval.sessionId).toBe(expected.sessionId); expect(approval.id).toBe(row.approval_id);
            expect(approval.turnId).toBe(row.turn_id); expect(approval.status).toBe(row.status); return approval; });
          expect(approvals.length).toBe(1); expect(approvals[0]).toMatchObject({ id: expected.approvalId, turnId: expected.turnId,
            toolCallId: expected.toolCallId, status: "resolved", decision: "acceptForSession" });
          const [foreign] = await observer.query<RowDataPacket[]>({ sql: "SELECT COUNT(*) AS n FROM sessions WHERE BINARY session_id=BINARY ? AND (BINARY tenant_id=BINARY ? OR BINARY user_id=BINARY ?)", timeout: 5000 },
            [expected.sessionId, "tenant_other_hooks", "trusted-caller-hooks"]);
          expect(integer(foreign[0]?.n)).toBe(0);
          if (!final) {
            expect(turns.length).toBe(1); expect(turns[0]).toMatchObject({ id: expected.turnId, status: "inProgress" });
            const calls = items.filter(item => item.type === "toolCall"), results = items.filter(item => item.type === "toolResult");
            expect(calls.length).toBe(1); expect(results.length).toBe(1);
            expect(calls[0]).toMatchObject({ name: expected.toolName, kind: "mcp", toolCallId: expected.toolCallId,
              status: "completed", startedAtMs: expect.any(Number) });
            expect(results[0]).toMatchObject({ id: expected.resultItemId, name: expected.toolName, toolCallId: expected.toolCallId,
              status: "completed", isError: false, content: [{ type: "text", text: expected.resultText }] });
            const reports = events.filter(event => event.type === "hook/completed");
            expect(reports.length).toBe(1); expect(reports[0]).toMatchObject({ hookId: "pre_policy", phase: "preToolUse", kind: "webhook",
              outcome: "allowed", toolCallId: expected.toolCallId, configSha256: expected.preConfigSha256 });
            const approval = events.find(event => event.type === "approval/requested"), committed = events.find(event => event.type === "item/completed" && event.item.id === expected.resultItemId);
            if (!approval || !committed) throw new Error("Hooks fixture SQL boundary evidence is missing.");
            expect(reports[0]!.seq).toBeLessThan(approval.seq); expect(approval.seq).toBeLessThan(committed.seq);
            expect(integer(session.last_seq)).toBe(committed.seq); expect(events.some(event => event.type === "turn/completed")).toBe(false);
          } else {
            expect(integer(session.last_seq)).toBe(final.finalSeq); finalFacts(final, items, events, turns, approvals);
          }
          await observer.query({ sql: "ROLLBACK", timeout: 5000 }); inTransaction = false; checkDeadline();
        } finally {
          try { if (inTransaction) await observer.query({ sql: "ROLLBACK", timeout: 5000 }); }
          finally { await closeObserver(); }
        }
      }
      try {
        // The configured base database is never opened, migrated, written, flushed or dropped.
        // Administrative DDL uses /mysql only; ambiguous CREATE never authorizes a DROP.
        adminUncertain = true; admin = await mysql.createConnection({ uri: adminUrl, connectTimeout: 5000 }); adminUncertain = false; checkDeadline();
        const [existing] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", timeout: 5000 }, [database]);
        expect(existing.length).toBe(0); checkDeadline();
        const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: mysqlUrl,
          applicationDatabase: database, operationAbortSignal: operation.signal });
        checkDeadline(); createAttempted = true;
        await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`, timeout: 5000 }); created = true;
        await closeAdmin(); checkDeadline();
        runtime = await prepareMysqlRuntimeFixture(witness, {
          schemaExecutor: options => MysqlSessionStore.runSchemaOperation(options),
          authorityExecutor: createSourceAuthorityExecutor(),
        });
        checkDeadline(); await runtime.assertReusable(mysqlUrl); checkDeadline(); stage = "runtime";
        const result = await runHooksVertical({ mysqlUrl, mysqlRuntimeEnv: runtime.runtimeEnv, onBeforePostAck: async expected => {
          stage = "before_post_ack"; postCount++;
          await inspectCommitted(expected); checkDeadline(); boundary.post = expected; boundary.completed = true; stage = "runtime";
        }, onOwnedServicesClosed: () => { ownedServicesClosed = true; } });
        checkDeadline(); expect(result.profile).toBe("source-mysql-only"); expect(result.remoteCalls).toBe(1); expect(result.webhookRequests).toBe(3);
        expect(ownedServicesClosed).toBe(true); expect(postCount).toBe(1); expect(boundary.completed).toBe(true);
        const expected = boundary.post; if (!expected) throw new Error("Hooks fixture post boundary was not observed.");
        expect(expected.turnId).toBe(result.firstTurnId); expect(expected.approvalScope).toBe(result.approvalScope);
        stage = "cold_connect"; coldUncertain = true;
        await runtime.assertReusable(mysqlUrl); checkDeadline();
        cold = await MysqlSessionStore.connect({ ...runtime.runtimeStoreOptions, connectionLimit: 2,
          operationAbortSignal: operation.signal }); coldUncertain = false;
        // Late completion owns a real pool but cannot continue/promote success: finally closes it.
        checkDeadline(); stage = "cold_read";
        const session = await cold.getSession(result.owner.tenantId, result.sessionId);
        expect(session).toMatchObject({ tenantId: result.owner.tenantId, userId: result.owner.userId,
          status: { type: "idle" }, lastSeq: result.finalSeq }); expect(session?.autoApprovedTools).toEqual([result.approvalScope]);
        expect(await cold.getSession("tenant_other_hooks", result.sessionId)).toBeNull();
        const firstTurn = await cold.getTurn(result.sessionId, result.firstTurnId), secondTurn = await cold.getTurn(result.sessionId, result.secondTurnId);
        if (!firstTurn || !secondTurn) throw new Error("Hooks fixture cold turns are missing.");
        const items = await cold.listItems(result.sessionId, { limit: 200 }), events = await cold.readEvents(result.sessionId, 0, 200);
        finalFacts(result, items, events, [firstTurn, secondTurn], await cold.listApprovals(result.sessionId, {}));
        checkDeadline(); stage = "close"; coldUncertain = true; await cold.close(); cold = undefined; coldUncertain = false;
        stage = "cold_sql"; await inspectCommitted(expected, result); checkDeadline(); bodyPassed = true;
      } catch { failure(); }
      finally {
        stage = "close";
        if (cold) { coldUncertain = true; try { await cold.close(); cold = undefined; coldUncertain = false; } catch { failure(); } }
        try { await closeObserver(); } catch { failure(); } try { await closeAdmin(); } catch { failure(); }
        if (runtime) {
          const successful = !deadlineExpired() && bodyPassed && !failureStage && ownedServicesClosed
            && !cold && !coldUncertain && !observer && !observerUncertain && !admin && !adminUncertain;
          try { await runtime.close({ successful }); runtimeReleased = successful; } catch { failure(); }
        }
        stage = "cleanup"; const cleanupExpired = deadlineExpired();
        if (!cleanupExpired && created && bodyPassed && !failureStage && runtimeReleased && ownedServicesClosed && !cold && !coldUncertain && !observer && !observerUncertain && !admin && !adminUncertain) {
          try {
            // Fresh inspector, after all fixture writers/pools/readers have really closed. Never
            // KILL another connection or DROP after an assertion failure/ambiguous cleanup.
            adminUncertain = true; admin = await mysql.createConnection({ uri: adminUrl, connectTimeout: 5000 }); adminUncertain = false; checkDeadline();
            const [connections] = await admin.query<RowDataPacket[]>({ sql: "SELECT ID FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND (BINARY DB=BINARY ? OR LOCATE(?,COALESCE(INFO,''))>0)", timeout: 5000 }, [database, database]);
            expect(connections.length).toBe(0);
            if (!OWNED_DATABASE.test(database) || database === decodeURIComponent(base.pathname.slice(1))) throw new Error("Hooks fixture DROP ownership check failed");
            checkDeadline(); await admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5000 });
            const [remaining] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", timeout: 5000 }, [database]);
            expect(remaining.length).toBe(0); dropped = true;
          } catch { failure(); }
          finally { try { await closeAdmin(); } catch { failure(); } }
        }
        cleanupPassed = !deadlineExpired() && created && dropped && !admin && !adminUncertain && !observer && !observerUncertain && !cold && !coldUncertain && ownedServicesClosed;
        if (created && !cleanupPassed || createAttempted && !created) failure(); clearTimeout(timer);
      }
      if (!bodyPassed || !cleanupPassed || failureStage) {
        // Diagnostics are only a closed stage and exact owned random DB name, never native
        // errors, URLs, provider/header/key material or a webhook's body.
        throw new Error(`Tool hooks MySQL vertical failed at ${failureStage ?? stage}; owned fixture ${dropped ? "dropped" : "retained if present"}: ${database}`);
      }
    }, 60_000);
  });
} else {
  describe("tool hooks real source bootstrap vertical with fresh isolated MySQL", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 and MYSQL_TEST_URL for the fresh real MySQL vertical", () => {});
  });
}
