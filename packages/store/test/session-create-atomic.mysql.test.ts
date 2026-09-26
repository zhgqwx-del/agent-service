import { describe, expect, it } from "vitest";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { MysqlSessionStore } from "../src/index.js";
import { mkSession } from "./conformance.js";

const MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore atomic session creation", () => {
    it("rolls back the session row when the creation-event insert fails", async () => {
      const store = await MysqlSessionStore.connect({ url: MYSQL_URL, connectionLimit: 2 });
      const conn = await mysql.createConnection(MYSQL_URL);
      const session = mkSession("tenant_atomic_rollback", "user_atomic_rollback");
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
        expect(sessionRows).toEqual([]);
        expect(eventRows).toEqual([]);
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``).catch(() => {});
        await conn.end();
        await store.close();
      }
    });
  });
} else {
  describe("MysqlSessionStore atomic session creation", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
