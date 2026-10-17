import { randomBytes } from "node:crypto";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { MysqlSessionStore } from "@agent-service/store";
import { runMcpVertical } from "./fixtures/mcp-vertical.js";

function disposableBase(): URL {
  const raw = process.env.MYSQL_TEST_URL;
  if (!raw) throw new Error("MYSQL_TEST_URL is required for the isolated MCP MySQL vertical");
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/^[A-Za-z0-9_]+$/.test(database) || !/(?:^|_)test(?:$|_)/i.test(database)
    || !url.username || url.search || url.hash) {
    throw new Error("MYSQL_TEST_URL must identify loopback MySQL and a test database without URL options");
  }
  return url;
}
function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("M3.1a real router/Pi/MCP vertical with isolated MySQL", () => {
    it("persists approval suspension, successful result and exact session grant across a verify-only cold connection", async () => {
      const base = disposableBase();
      // Never migrate, write, FLUSH or DROP the supplied base/shared database. Only this exact
      // absent-checked random name can become an owned fixture resource.
      const database = `agent_service_mcp_vertical_test_${randomBytes(12).toString("hex")}`;
      const mysqlUrl = databaseUrl(base, database);
      let admin: Connection | undefined;
      let created = false;
      let createAttempted = false;
      let ownedServicesClosed = false;
      let cold: MysqlSessionStore | undefined;
      let coldConnectionUncertain = false;
      const failures: unknown[] = [];
      try {
        admin = await mysql.createConnection({ uri: databaseUrl(base, "mysql"), connectTimeout: 5_000 });
        const [existing] = await admin.query<RowDataPacket[]>(
          "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database],
        );
        if (existing.length !== 0) throw new Error("MCP fixture database unexpectedly exists; ownership rejected");
        createAttempted = true;
        await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
        created = true;
        const result = await runMcpVertical({ mysqlUrl, approvalDecision: "acceptForSession",
          onOwnedServicesClosed: () => { ownedServicesClosed = true; } });
        expect(ownedServicesClosed).toBe(true);
        // The actual runner has closed its pool and all listeners before this fresh, DDL-free
        // connection checks the durable result. No direct SQL edits manufacture a grant or item.
        coldConnectionUncertain = true;
        cold = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2, migrationMode: "verify" });
        coldConnectionUncertain = false;
        const session = await cold.getSession(result.owner.tenantId, result.sessionId);
        expect(session).toMatchObject({ userId: result.owner.userId, status: { type: "idle" }, lastSeq: result.finalSeq });
        expect(session?.autoApprovedTools).toEqual([result.approvalScope]);
        expect(session?.autoApprovedTools).not.toContain(result.toolName);
        expect(await cold.getSession("t_other_mcp_vertical", result.sessionId)).toBeNull();
        expect(await cold.getApproval(result.sessionId, result.approvalId)).toMatchObject({
          status: "resolved", decision: "acceptForSession", toolName: result.toolName, decidedBy: result.owner.userId,
        });
        expect(await cold.getTurn(result.sessionId, result.turnId)).toMatchObject({
          status: "completed", stopReason: "end_turn", steps: 2, toolCalls: 1,
        });
        const items = await cold.listItems(result.sessionId, { limit: 100 });
        expect(items.filter(item => item.type === "toolCall")).toEqual([
          expect.objectContaining({ kind: "mcp", name: result.toolName, status: "completed", startedAtMs: expect.any(Number) }),
        ]);
        expect(items.filter(item => item.type === "toolResult")).toEqual([
          expect.objectContaining({ name: result.toolName, isError: false, content: [{ type: "text", text: result.toolResult }] }),
        ]);
        const events = await cold.readEvents(result.sessionId, 0, 100);
        expect(events.map(event => event.seq)).toEqual(Array.from({ length: result.finalSeq }, (_, index) => index + 1));
        expect(events.some(event => event.type === "approval/resolved" && event.approval.id === result.approvalId
          && event.approval.decision === "acceptForSession")).toBe(true);
        expect(events.some(event => event.type === "item/completed" && event.item.type === "toolResult"
          && event.item.name === result.toolName && !event.item.isError)).toBe(true);
        expect(events.slice(-2)).toMatchObject([
          { type: "turn/completed", turn: { id: result.turnId, status: "completed" } },
          { type: "session/status/changed", status: { type: "idle" } },
        ]);
      } catch (error) {
        failures.push(error);
      } finally {
        if (cold) {
          coldConnectionUncertain = true;
          try { await cold.close(); cold = undefined; coldConnectionUncertain = false; }
          catch (error) { failures.push(error); }
        }
        if (admin) {
          try {
            if (created) {
              if (!ownedServicesClosed || coldConnectionUncertain || cold) {
                throw new Error(`MCP owned fixture database retained because shutdown is not proven: ${database}`);
              }
              const [connections] = await admin.query<RowDataPacket[]>(
                "SELECT ID FROM information_schema.PROCESSLIST WHERE DB=?", [database],
              );
              if (connections.length !== 0) throw new Error(`MCP owned fixture database retained because connections remain: ${database}`);
              if (!/^agent_service_mcp_vertical_test_[0-9a-f]{24}$/.test(database)) {
                throw new Error("MCP fixture database DROP ownership check failed");
              }
              await admin.query(`DROP DATABASE \`${database}\``);
              created = false;
            } else if (createAttempted) {
              // A lost CREATE response is not ownership proof. Do not probe-and-drop a database
              // whose creation outcome is ambiguous, even if the random name now exists.
              throw new Error(`MCP fixture database creation outcome is uncertain; retained if present: ${database}`);
            }
          } catch (error) { failures.push(error); }
          try { await admin.end(); } catch (error) { failures.push(error); }
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "MCP MySQL vertical or owned-resource cleanup failed");
    }, 60_000);
  });
} else {
  describe("M3.1a real router/Pi/MCP vertical with isolated MySQL", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 and MYSQL_TEST_URL to exercise real MySQL", () => {});
  });
}
