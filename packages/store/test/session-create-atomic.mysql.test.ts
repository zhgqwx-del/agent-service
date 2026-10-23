import { afterAll, describe, expect, it } from "vitest";
import type { RowDataPacket } from "mysql2/promise";
import { CurrentMysqlRuntimeOwner } from "./fixtures/current-mysql-runtime.js";
import { mkSession } from "./conformance.js";

const MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore atomic session creation", () => {
    const owners = new Set<CurrentMysqlRuntimeOwner>();
    afterAll(async () => {
      const closed = await Promise.allSettled([...owners].map(owner => owner.close({ successful: false })));
      const failed = closed.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Current atomic fixture cleanup failed");
    });

    it("rolls back the session row when the creation-event insert fails", async context => {
      const mysqlOwner = new CurrentMysqlRuntimeOwner(MYSQL_URL); owners.add(mysqlOwner);
      const cancel = () => { void mysqlOwner.close({ successful: false }).catch(() => {}); };
      context.signal.addEventListener("abort", cancel, { once: true });
      if (context.signal.aborted) cancel();
      let hasError = false, firstError: unknown;
      try {
        await mysqlOwner.prepare();
        const store = await mysqlOwner!.openStore(2);
        const conn = await mysqlOwner!.openInspection();
        const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        const session = mkSession(`tenant_atomic_${suffix}`, `user_atomic_${suffix}`);
        const triggerName = `test_atomic_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

        try {
          // Fail only this session's event insert, after the session INSERT has already succeeded in the
          // transaction. This exercises an actual InnoDB rollback rather than a pre-write validation path.
          await conn.query(
            `CREATE TRIGGER \`${triggerName}\` BEFORE INSERT ON events FOR EACH ROW
             BEGIN
               IF NEW.session_id = ? THEN
                 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected creation-event insert failure';
               END IF;
             END`,
            [session.id],
          );

          await expect(store.createSession(session)).rejects.toThrow("injected creation-event insert failure");

          const [sessionRows] = await conn.query<RowDataPacket[]>("SELECT session_id, last_seq FROM sessions WHERE session_id=?", [session.id]);
          const [eventRows] = await conn.query<RowDataPacket[]>("SELECT session_id, seq FROM events WHERE session_id=?", [session.id]);
          const [subjectRows] = await conn.query<RowDataPacket[]>(
            "SELECT subject_kind, subject_id FROM subject_lifecycle WHERE tenant_id=?",
            [session.tenantId],
          );
          expect(sessionRows).toEqual([]);
          expect(eventRows).toEqual([]);
          expect(subjectRows).toEqual([]);
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
  describe("MysqlSessionStore atomic session creation", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
