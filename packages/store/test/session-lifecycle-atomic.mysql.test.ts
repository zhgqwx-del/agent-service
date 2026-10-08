import { describe, expect, it } from "vitest";
import mysql, { type RowDataPacket } from "mysql2/promise";
import type { Approval, Item } from "@agent-service/protocol";
import { MysqlSessionStore } from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore atomic session lifecycle", () => {
    it("rolls back events, approvals, items and session state when the archive update fails", async () => {
      const store = await MysqlSessionStore.connect({ url: MYSQL_URL, connectionLimit: 2 });
      const conn = await mysql.createConnection(MYSQL_URL);
      const session = mkSession("tenant_lifecycle_rollback", "user_lifecycle_rollback");
      const triggerName = `test_lifecycle_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const now = Date.now();
      const approval: Approval = {
        id: newId("apr"),
        sessionId: session.id,
        turnId: newId("turn"),
        itemId: newId("item"),
        status: "pending",
        toolCallId: "legacy-call",
        toolName: "danger",
        args: { value: "original" },
        availableDecisions: ["accept", "decline"],
        createdAtMs: now,
        expiresAtMs: now + 60_000,
      };
      const approvalItem: Item = {
        id: approval.itemId,
        sessionId: session.id,
        turnId: approval.turnId,
        seq: 0,
        status: "inProgress",
        createdAtMs: now,
        type: "approvalRequest",
        approvalId: approval.id,
        toolCallId: approval.toolCallId,
        name: approval.toolName,
        args: approval.args,
      };

      try {
        await store.createSession(session);
        await store.commit({
          sessionId: session.id,
          fence: 1,
          approvals: [approval],
          items: [approvalItem],
          sessionPatch: { autoApprovedTools: ["danger"] },
        });

        // The lifecycle transaction inserts events and updates the approval/item before it updates
        // the session row. Failing this final UPDATE therefore exercises a real InnoDB rollback of
        // every preceding write, including lastSeq and the new fence.
        await conn.query(
          `CREATE TRIGGER \`${triggerName}\` BEFORE UPDATE ON sessions FOR EACH ROW
           BEGIN
             IF NEW.session_id = ? AND NEW.archived_at_ms IS NOT NULL THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected lifecycle session update failure';
             END IF;
           END`,
          [session.id],
        );

        const archivedApproval: Approval = {
          ...approval,
          status: "expired",
          decision: "cancel",
          decidedBy: "system:archive",
          resolvedAtMs: now + 1,
        };
        const archivedItem: Item = {
          ...approvalItem,
          status: "declined",
          completedAtMs: now + 1,
        };
        await expect(store.commit({
          sessionId: session.id,
          fence: 2,
          lifecycle: {
            type: "archive",
            atMs: now + 1,
            tenantId: session.tenantId,
            userId: session.userId,
          },
          approvals: [archivedApproval],
          items: [archivedItem],
          events: [
            { type: "approval/resolved", sessionId: session.id, emittedAtMs: now + 1, approval: archivedApproval },
            { type: "item/completed", sessionId: session.id, emittedAtMs: now + 1, item: archivedItem },
            { type: "session/archived", sessionId: session.id, emittedAtMs: now + 1 },
          ],
          sessionPatch: { autoApprovedTools: [] },
        })).rejects.toThrow("injected lifecycle session update failure");

        expect(await store.getSession(session.tenantId, session.id)).toMatchObject({
          archivedAtMs: undefined,
          autoApprovedTools: ["danger"],
          fenceToken: 1,
          lastSeq: 1,
        });
        const storedApproval = await store.getApproval(session.id, approval.id);
        expect(storedApproval).toMatchObject({ status: "pending" });
        expect(storedApproval?.decision).toBeUndefined();
        expect(storedApproval?.resolvedAtMs).toBeUndefined();
        const storedItem = await store.getItem(session.id, approvalItem.id);
        expect(storedItem).toMatchObject({ status: "inProgress" });
        expect(storedItem?.completedAtMs).toBeUndefined();
        expect((await store.readEvents(session.id, 0, 20)).map((event) => event.type)).toEqual(["session/created"]);

        const [rows] = await conn.query<(RowDataPacket & { archived_at_ms: number | null; last_seq: number; fence_token: number })[]>(
          "SELECT archived_at_ms, last_seq, fence_token FROM sessions WHERE session_id=?",
          [session.id],
        );
        expect(rows[0]).toMatchObject({ archived_at_ms: null, last_seq: 1, fence_token: 1 });
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``).catch(() => {});
        await conn.end();
        await store.close();
      }
    });
  });
} else {
  describe("MysqlSessionStore atomic session lifecycle", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
