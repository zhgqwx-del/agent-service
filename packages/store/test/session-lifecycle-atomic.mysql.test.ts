import { afterAll, describe, expect, it } from "vitest";
import type { RowDataPacket } from "mysql2/promise";
import { CurrentMysqlRuntimeOwner, type CurrentMysqlInspection } from "./fixtures/current-mysql-runtime.js";
import { acquireFixtureSessionAuthority } from "./fixtures/session-authority.js";

import type { Approval, Item } from "@agent-service/protocol";

import { mkSession, newId } from "./conformance.js";

async function snapshot(conn: CurrentMysqlInspection, sessionId: string) {
  const result: Record<string, unknown[]> = {};
  for (const table of ["sessions", "turns", "items", "approvals", "events", "lifecycle_outbox"]) {
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${table} WHERE ${table === "lifecycle_outbox" ? "aggregate_id" : "session_id"}=?`, [sessionId]);
    result[table] = rows.map(row => ({ ...row })).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}

const MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore atomic session lifecycle", () => {
    const owners = new Set<CurrentMysqlRuntimeOwner>();
    afterAll(async () => {
      const closed = await Promise.allSettled([...owners].map(owner => owner.close({ successful: false })));
      const failed = closed.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Current atomic fixture cleanup failed");
    });

    it("rolls back events, approvals, items and session state when the archive update fails", async context => {
      const mysqlOwner = new CurrentMysqlRuntimeOwner(MYSQL_URL); owners.add(mysqlOwner);
      const cancel = () => { void mysqlOwner.close({ successful: false }).catch(() => {}); };
      context.signal.addEventListener("abort", cancel, { once: true });
      if (context.signal.aborted) cancel();
      let hasError = false, firstError: unknown;
      try {
        await mysqlOwner.prepare();
        const store = await mysqlOwner!.openStore(2);
        const conn = await mysqlOwner!.openInspection();
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
          const lease = await acquireFixtureSessionAuthority(store, session, 0);
          await store.commit(lease.admit({
            sessionId: session.id,
            fence: 1,
            approvals: [approval],
            items: [approvalItem],
            sessionPatch: { autoApprovedTools: ["danger"] },
          }));

          const beforeFailure = await snapshot(conn, session.id);
          // The prior real acquisition owns P1. Failing this final UPDATE exercises rollback
          // of the complete business write set without rolling back that successful acquisition.
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
          await expect(store.commit(lease.admit({
            sessionId: session.id,
            fence: lease.fence,
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
          }))).rejects.toThrow("injected lifecycle session update failure");

          expect(await snapshot(conn, session.id)).toEqual(beforeFailure);
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

      } catch (error) { hasError = true; firstError = error; }
      try { await mysqlOwner.close({ successful: !hasError && !context.signal.aborted }); }
      catch (error) { if (!hasError) { hasError = true; firstError = error; } }
      finally { context.signal.removeEventListener("abort", cancel); }
      if (hasError) throw firstError;
    });

    it("rolls back the deletion event, both outbox intents and marker when tombstone update fails", async context => {
      const mysqlOwner = new CurrentMysqlRuntimeOwner(MYSQL_URL); owners.add(mysqlOwner);
      const cancel = () => { void mysqlOwner.close({ successful: false }).catch(() => {}); };
      context.signal.addEventListener("abort", cancel, { once: true });
      if (context.signal.aborted) cancel();
      let hasError = false, firstError: unknown;
      try {
        await mysqlOwner.prepare();
        const store = await mysqlOwner!.openStore(2);
        const conn = await mysqlOwner!.openInspection();
        const session = mkSession("tenant_tombstone_rollback", "user_tombstone_rollback");
        const triggerName = `test_tombstone_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        const now = Date.now();

        try {
          await store.createSession(session);
          const lease = await acquireFixtureSessionAuthority(store, session, 0);
          const beforeFailure = await snapshot(conn, session.id);
          // Events and both outbox rows are inserted before the final sessions UPDATE. This trigger
          // therefore proves InnoDB rolls the complete tombstone write set back as one unit.
          await conn.query(
            `CREATE TRIGGER \`${triggerName}\` BEFORE UPDATE ON sessions FOR EACH ROW
             BEGIN
               IF NEW.session_id = ? AND NEW.deleted_at_ms IS NOT NULL THEN
                 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected tombstone session update failure';
               END IF;
             END`,
            [session.id],
          );

          await expect(store.commit(lease.admit({
            sessionId: session.id,
            fence: 1,
            lifecycle: {
              type: "tombstone",
              atMs: now,
              deletionGeneration: 1,
              tenantId: session.tenantId,
              userId: session.userId,
            },
            events: [{
              type: "session/deleted",
              sessionId: session.id,
              emittedAtMs: now,
              deletionGeneration: 1,
            }],
          }))).rejects.toThrow("injected tombstone session update failure");

          expect(await snapshot(conn, session.id)).toEqual(beforeFailure);
          expect(await store.getSession(session.tenantId, session.id)).toMatchObject({
            fenceToken: lease.fence,
            lastSeq: 1,
          });
          expect(await store.getSessionLifecycle(session.tenantId, session.userId, session.id)).toMatchObject({
            deletedAtMs: undefined,
            purgeAfterMs: undefined,
            deletionGeneration: 0,
          });
          expect((await store.readEvents(session.id, 0, 20)).map((event) => event.type)).toEqual(["session/created"]);
          expect(await store.getLifecycleOutbox("session.tombstoned", session.id, 1)).toBeNull();
          expect(await store.getLifecycleOutbox("session.purge", session.id, 1)).toBeNull();

          const [rows] = await conn.query<(RowDataPacket & {
            deleted_at_ms: number | null;
            purge_after_ms: number | null;
            deletion_generation: number;
            last_seq: number;
            fence_token: number;
          })[]>(
            `SELECT deleted_at_ms, purge_after_ms, deletion_generation, last_seq, fence_token
               FROM sessions WHERE session_id=?`,
            [session.id],
          );
          expect(rows[0]).toMatchObject({
            deleted_at_ms: null,
            purge_after_ms: null,
            deletion_generation: 0,
            last_seq: 1,
            fence_token: lease.fence,
          });
          const [outbox] = await conn.query<(RowDataPacket & { count: number })[]>(
            "SELECT COUNT(*) AS count FROM lifecycle_outbox WHERE aggregate_id=?",
            [session.id],
          );
          expect(Number(outbox[0]?.count)).toBe(0);
        } finally {
          await conn.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``).catch(() => {});
          await conn.end();
          await store.close();
        }

      } catch (error) { hasError = true; firstError = error; }
      try { await mysqlOwner.close({ successful: !hasError && !context.signal.aborted }); }
      catch (error) { if (!hasError) { hasError = true; firstError = error; } }
      finally { context.signal.removeEventListener("abort", cancel); }
      if (hasError) throw firstError;
    });
  });
} else {
  describe("MysqlSessionStore atomic session lifecycle", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
