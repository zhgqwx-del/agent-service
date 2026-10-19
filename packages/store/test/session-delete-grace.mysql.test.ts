import { randomUUID } from "node:crypto";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore, ORDINARY_SESSION_DELETE_GRACE_MS, SessionGoneError } from "../src/index.js";
import { mkSession } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error("MYSQL_TEST_URL must target local disposable MySQL");
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function ordinaryDelete(store: MysqlSessionStore, session: ReturnType<typeof mkSession>) {
  const atMs = Date.now();
  return store.commitOrdinarySessionDelete({
    sessionId: session.id, fence: 1,
    lifecycle: {
      type: "tombstone", tenantId: session.tenantId, userId: session.userId,
      atMs, purgeAfterMs: null, deletionGeneration: 1,
    },
    events: [{ type: "session/deleted", sessionId: session.id,
      emittedAtMs: atMs, deletionGeneration: 1 }],
  });
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore ordinary DELETE grace", () => {
    let admin: Connection | undefined;
    let mysqlUrl: string;
    let database = "";
    let created = false;

    beforeAll(async () => {
      const base = disposableBase(BASE_MYSQL_URL);
      database = `agent_service_grace_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      admin = await mysql.createConnection(databaseUrl(base, "mysql"));
      const [existing] = await admin.query<RowDataPacket[]>(
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database],
      );
      if (existing.length) throw new Error("disposable grace fixture database already exists");
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      created = true;
      mysqlUrl = databaseUrl(base, database);
      const migrated = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      await migrated.close();
    });

    afterAll(async () => {
      if (admin) {
        if (created) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
        await admin.end();
      }
    });

    it("atomically writes origin and serializes concurrent post-COMMIT seals", async () => {
      const first = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const second = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(`tenant-grace-${randomUUID()}`, `user-grace-${randomUUID()}`);
      try {
        await first.createSession(session);
        expect(await first.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id)).toBeNull();
        const result = await ordinaryDelete(first, session);
        expect(result.events.at(-1)).toMatchObject({ type: "session/deleted", seq: 2 });
        expect(await first.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
          .toEqual({ state: "unknown", executionReady: false, physicalPurgeEnabled: false });
        const [originRows] = await conn.query<RowDataPacket[]>(
          `SELECT ordinary_delete_origin_sha256,ordinary_delete_origin_observed_db_ms,
                  ordinary_delete_seal_observed_db_ms,purge_after_ms
             FROM sessions WHERE session_id=?`,
          [session.id],
        );
        expect(String(originRows[0]?.ordinary_delete_origin_sha256)).toMatch(/^[0-9a-f]{64}$/);
        expect(originRows[0]?.ordinary_delete_seal_observed_db_ms).toBeNull();
        expect(originRows[0]?.purge_after_ms).toBeNull();
        const [postCommitClock] = await conn.query<RowDataPacket[]>(
          "SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS now_ms",
        );
        await Promise.all([
          first.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id),
          second.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id),
        ]);
        expect(await first.retryUnsealedOrdinarySessionDeleteGraceOrigins(1)).toBe(0);
        const [sealed] = await conn.query<RowDataPacket[]>(
          `SELECT ordinary_delete_origin_observed_db_ms AS origin_ms,
                  ordinary_delete_seal_observed_db_ms AS seal_ms,
                  ordinary_delete_grace_floor_db_ms AS floor_ms,
                  ordinary_delete_seal_sha256 AS seal_sha
             FROM sessions WHERE session_id=?`,
          [session.id],
        );
        expect(Number(sealed[0]?.seal_ms)).toBeGreaterThanOrEqual(Number(sealed[0]?.origin_ms));
        expect(Number(sealed[0]?.seal_ms)).toBeGreaterThanOrEqual(Number(postCommitClock[0]?.now_ms));
        expect(Number(sealed[0]?.floor_ms)).toBe(Number(sealed[0]?.seal_ms)
          + 1 + ORDINARY_SESSION_DELETE_GRACE_MS);
        expect(String(sealed[0]?.seal_sha)).toMatch(/^[0-9a-f]{64}$/);
        expect(await first.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
          .toEqual({ state: "sealed", graceFloorDbMs: Number(sealed[0]?.floor_ms),
            executionReady: false, physicalPurgeEnabled: false });
        expect(await second.getOrdinarySessionDeleteGrace(session.tenantId, "wrong-user", session.id)).toBeNull();
        expect(await second.getOrdinarySessionDeleteGrace("wrong-tenant", session.userId, session.id)).toBeNull();
        const [outbox] = await conn.query<RowDataPacket[]>(
          "SELECT available_at_ms,claim_token FROM lifecycle_outbox WHERE topic='session.purge' AND aggregate_id=?",
          [session.id],
        );
        expect(outbox[0]?.available_at_ms).toBeNull();
        expect(outbox[0]?.claim_token).toBeNull();
        await expect(conn.query(
          "UPDATE sessions SET purge_after_ms=? WHERE session_id=?",
          [Number(sealed[0]?.floor_ms), session.id],
        )).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
      } finally {
        await conn.end();
        await first.close();
        await second.close();
      }
    });

    it("rejects SQL rewrites and late backfill while preserving the legal post-COMMIT seal", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const conn = await mysql.createConnection(mysqlUrl);
      const ordinary = mkSession(`tenant-grace-guard-${randomUUID()}`,
        `user-grace-guard-${randomUUID()}`);
      const simultaneous = mkSession(`tenant-grace-simultaneous-${randomUUID()}`,
        `user-grace-simultaneous-${randomUUID()}`);
      const legacy = mkSession(`tenant-grace-legacy-${randomUUID()}`,
        `user-grace-legacy-${randomUUID()}`);
      try {
        await store.createSession(simultaneous);
        const simultaneousAtMs = Date.now();
        await expect(conn.query(
          `UPDATE sessions SET deleted_at_ms=?,deletion_generation=1,
                  ordinary_delete_origin_sha256=REPEAT('a',64),
                  ordinary_delete_origin_observed_db_ms=?,
                  ordinary_delete_seal_observed_db_ms=?,
                  ordinary_delete_grace_floor_db_ms=?,
                  ordinary_delete_seal_sha256=REPEAT('b',64)
             WHERE session_id=?`,
          [simultaneousAtMs, simultaneousAtMs, simultaneousAtMs,
            simultaneousAtMs + 2_592_000_001, simultaneous.id],
        )).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        const [stillLive] = await conn.query<RowDataPacket[]>(
          `SELECT deleted_at_ms,ordinary_delete_origin_sha256
             FROM sessions WHERE session_id=?`, [simultaneous.id],
        );
        expect(stillLive[0]).toMatchObject({ deleted_at_ms: null,
          ordinary_delete_origin_sha256: null });

        await store.createSession(ordinary);
        await ordinaryDelete(store, ordinary);
        const [origin] = await conn.query<RowDataPacket[]>(
          `SELECT title,last_seq,deletion_generation,
                  ordinary_delete_origin_sha256 AS sha,
                  ordinary_delete_origin_observed_db_ms AS observed_ms
             FROM sessions WHERE session_id=?`, [ordinary.id],
        );
        expect(String(origin[0]?.sha)).toMatch(/^[0-9a-f]{64}$/);
        await expect(conn.query(
          `UPDATE sessions SET title='unauthorized rewrite',
                  ordinary_delete_origin_sha256=REPEAT('a',64)
             WHERE session_id=?`, [ordinary.id],
        )).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        await expect(conn.query(
          `UPDATE sessions SET ordinary_delete_origin_observed_db_ms=? WHERE session_id=?`,
          [Number(origin[0]?.observed_ms) + 1, ordinary.id],
        )).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        await expect(conn.query(
          `UPDATE sessions SET user_id=UPPER(user_id) WHERE session_id=?`, [ordinary.id],
        )).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        await expect(conn.query(
          `UPDATE sessions SET last_seq=last_seq+1 WHERE session_id=?`, [ordinary.id],
        )).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        await expect(conn.query(
          `UPDATE sessions SET deletion_generation=deletion_generation+1 WHERE session_id=?`,
          [ordinary.id],
        )).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        const [afterOrigin] = await conn.query<RowDataPacket[]>(
          `SELECT title,user_id,last_seq,deletion_generation,
                  ordinary_delete_origin_sha256 AS sha,
                  ordinary_delete_origin_observed_db_ms AS observed_ms
             FROM sessions WHERE session_id=?`, [ordinary.id],
        );
        expect(afterOrigin[0]).toMatchObject(origin[0]!);
        expect(afterOrigin[0]?.user_id).toBe(ordinary.userId);

        await store.sealOrdinarySessionDeleteGrace(
          ordinary.tenantId, ordinary.userId, ordinary.id,
        );
        const [sealed] = await conn.query<RowDataPacket[]>(
          `SELECT ordinary_delete_seal_observed_db_ms AS seal_ms,
                  ordinary_delete_grace_floor_db_ms AS floor_ms,
                  ordinary_delete_seal_sha256 AS seal_sha
             FROM sessions WHERE session_id=?`, [ordinary.id],
        );
        expect(String(sealed[0]?.seal_sha)).toMatch(/^[0-9a-f]{64}$/);
        await expect(conn.query(
          `UPDATE sessions SET ordinary_delete_seal_observed_db_ms=?,
                  ordinary_delete_grace_floor_db_ms=?,
                  ordinary_delete_seal_sha256=REPEAT('b',64)
             WHERE session_id=?`,
          [Number(sealed[0]?.seal_ms) + 1, Number(sealed[0]?.floor_ms) + 1, ordinary.id],
        )).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        const [afterSeal] = await conn.query<RowDataPacket[]>(
          `SELECT ordinary_delete_seal_observed_db_ms AS seal_ms,
                  ordinary_delete_grace_floor_db_ms AS floor_ms,
                  ordinary_delete_seal_sha256 AS seal_sha
             FROM sessions WHERE session_id=?`, [ordinary.id],
        );
        expect(afterSeal[0]).toMatchObject(sealed[0]!);

        await store.createSession(legacy);
        const atMs = Date.now();
        await store.commit({
          sessionId: legacy.id, fence: 1,
          lifecycle: { type: "tombstone", tenantId: legacy.tenantId, userId: legacy.userId,
            atMs, purgeAfterMs: null, deletionGeneration: 1 },
          events: [{ type: "session/deleted", sessionId: legacy.id,
            emittedAtMs: atMs, deletionGeneration: 1 }],
        });
        await expect(conn.query(
          `UPDATE sessions SET ordinary_delete_origin_sha256=REPEAT('c',64),
                  ordinary_delete_origin_observed_db_ms=? WHERE session_id=?`,
          [Date.now(), legacy.id],
        )).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        expect(await store.getOrdinarySessionDeleteGrace(legacy.tenantId, legacy.userId, legacy.id))
          .toEqual({ state: "unknown", executionReady: false, physicalPurgeEnabled: false });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rejects forged generic provenance before any MySQL tombstone write", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const session = mkSession(`tenant-grace-forge-${randomUUID()}`,
        `user-grace-forge-${randomUUID()}`);
      try {
        await store.createSession(session);
        const atMs = Date.now();
        const forged = {
          sessionId: session.id, fence: 1,
          lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: session.userId,
            atMs, purgeAfterMs: null, deletionGeneration: 1,
            ordinaryDeleteGraceOrigin: true },
          events: [{ type: "session/deleted", sessionId: session.id,
            emittedAtMs: atMs, deletionGeneration: 1 }],
        } as unknown as Parameters<MysqlSessionStore["commit"]>[0];
        await expect(store.commit(forged)).rejects.toThrow(/not accepted/);
        expect((await store.readEvents(session.id, 0, 10)).map((event) => event.type))
          .toEqual(["session/created"]);
        expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
          .toBeNull();
        await expect(store.commitOrdinarySessionDelete({
          ...forged,
          lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: "wrong-user",
            atMs, purgeAfterMs: null, deletionGeneration: 1 },
        })).rejects.toBeInstanceOf(SessionGoneError);
        expect((await store.readEvents(session.id, 0, 10)).map((event) => event.type))
          .toEqual(["session/created"]);
        await ordinaryDelete(store, session);
        expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
          .toMatchObject({ state: "unknown", executionReady: false });
        await store.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id);
      } finally {
        await store.close();
      }
    });

    it("rolls back origin with terminal write failure, and can retry a failed seal exactly", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 3 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(`tenant-grace-${randomUUID()}`, `user-grace-${randomUUID()}`);
      const trigger = `test_grace_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      try {
        await store.createSession(session);
        await conn.query(`CREATE TRIGGER \`${trigger}\` BEFORE UPDATE ON sessions FOR EACH ROW
          BEGIN IF NEW.session_id=? AND NEW.ordinary_delete_origin_sha256 IS NOT NULL
             AND NEW.ordinary_delete_seal_sha256 IS NULL THEN
             SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected grace origin failure';
          END IF; END`, [session.id]);
        await expect(ordinaryDelete(store, session)).rejects.toThrow(/injected grace origin failure/);
        expect((await store.readEvents(session.id, 0, 10)).map((event) => event.type))
          .toEqual(["session/created"]);
        expect(await store.getLifecycleOutbox("session.purge", session.id, 1)).toBeNull();
        const [before] = await conn.query<RowDataPacket[]>(
          "SELECT ordinary_delete_origin_sha256,deleted_at_ms,last_seq,fence_token FROM sessions WHERE session_id=?",
          [session.id],
        );
        expect(before[0]).toMatchObject({ ordinary_delete_origin_sha256: null,
          deleted_at_ms: null, last_seq: 1, fence_token: 0 });
        await conn.query(`DROP TRIGGER \`${trigger}\``);
        await ordinaryDelete(store, session);
        await conn.query(`CREATE TRIGGER \`${trigger}\` BEFORE UPDATE ON sessions FOR EACH ROW
          BEGIN IF NEW.session_id=? AND NEW.ordinary_delete_seal_sha256 IS NOT NULL THEN
             SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected grace seal failure';
          END IF; END`, [session.id]);
        await expect(store.sealOrdinarySessionDeleteGrace(
          session.tenantId, session.userId, session.id,
        )).rejects.toThrow(/injected grace seal failure/);
        expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
          .toEqual({ state: "unknown", executionReady: false, physicalPurgeEnabled: false });
        await conn.query(`DROP TRIGGER \`${trigger}\``);
        expect(await store.retryUnsealedOrdinarySessionDeleteGraceOrigins(100))
          .toBeGreaterThanOrEqual(1);
        const firstSeal = await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id);
        expect(firstSeal).toMatchObject({ state: "sealed", executionReady: false });
        await store.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id);
        expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
          .toEqual(firstSeal);
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("serializes concurrent ordinary tombstones to one event, outbox pair and origin", async () => {
      const first = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 3 });
      const second = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 3 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(`tenant-grace-race-${randomUUID()}`, `user-grace-race-${randomUUID()}`);
      try {
        await first.createSession(session);
        const results = await Promise.allSettled([
          ordinaryDelete(first, session), ordinaryDelete(second, session),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const failure = results.find((result) => result.status === "rejected");
        expect(failure && "reason" in failure ? failure.reason : null).toBeInstanceOf(SessionGoneError);
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT s.last_seq,s.deletion_generation,s.ordinary_delete_origin_sha256,
                  (SELECT COUNT(*) FROM events e WHERE e.session_id=s.session_id
                    AND e.type='session/deleted') AS deleted_events,
                  (SELECT COUNT(*) FROM lifecycle_outbox o WHERE o.aggregate_id=s.session_id
                    AND o.generation=1) AS outbox_count
             FROM sessions s WHERE s.session_id=?`, [session.id],
        );
        expect(Number(rows[0]?.last_seq)).toBe(2);
        expect(Number(rows[0]?.deletion_generation)).toBe(1);
        expect(String(rows[0]?.ordinary_delete_origin_sha256)).toMatch(/^[0-9a-f]{64}$/);
        expect(Number(rows[0]?.deleted_events)).toBe(1);
        expect(Number(rows[0]?.outbox_count)).toBe(2);
      } finally {
        await conn.end();
        await first.close();
        await second.close();
      }
    });

    it("rolls back if a trigger silently strips the ordinary origin before commit", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 3 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(`tenant-grace-strip-${randomUUID()}`,
        `user-grace-strip-${randomUUID()}`);
      const trigger = `test_grace_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      try {
        await store.createSession(session);
        await conn.query(`CREATE TRIGGER \`${trigger}\` BEFORE UPDATE ON sessions FOR EACH ROW
          BEGIN IF NEW.session_id=? AND NEW.ordinary_delete_origin_sha256 IS NOT NULL THEN
            SET NEW.ordinary_delete_origin_sha256=NULL;
            SET NEW.ordinary_delete_origin_observed_db_ms=NULL;
          END IF; END`, [session.id]);
        await expect(ordinaryDelete(store, session)).rejects.toThrow(/origin was not published/);
        expect((await store.readEvents(session.id, 0, 10)).map((event) => event.type))
          .toEqual(["session/created"]);
        expect(await store.getLifecycleOutbox("session.purge", session.id, 1)).toBeNull();
        expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
          .toBeNull();
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("rejects a same-name weakened CHECK on startup instead of trusting its marker", async ({ signal, onTestFailed }) => {
      const diagnosticStartedAt = performance.now();
      type DiagnosticPhase = "preflight" | "drift_create" | "fresh_apply" | "weaken_check"
        | "verify_reject" | "apply_reject" | "cleanup";
      let diagnosticPhase: DiagnosticPhase = "preflight";
      const snapshot = () => ({ phase: diagnosticPhase, elapsedMs: Math.max(0, Math.floor(performance.now() - diagnosticStartedAt)) });
      let firstDiagnostic: ReturnType<typeof snapshot> | undefined;
      const freezeDiagnostic = () => { try { firstDiagnostic ??= snapshot(); } catch { /* Observation cannot affect the case. */ } };
      signal.addEventListener("abort", freezeDiagnostic, { once: true });
      if (signal.aborted) freezeDiagnostic();
      onTestFailed(() => {
        try {
          const observed = firstDiagnostic ?? snapshot();
          console.error(JSON.stringify({ schema: "mysql-case-phase-diagnostic-v1", caseLabel: "session_delete_grace_weakened_check", ...observed }));
        } catch { /* Never replace the original failure with a diagnostic failure. */ }
      });
      const operator = admin;
      if (!operator) throw new Error("missing disposable fixture administrator");
      const base = disposableBase(BASE_MYSQL_URL);
      const driftDatabase = `agent_service_grace_drift_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      const [existing] = await operator.query<RowDataPacket[]>(
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?",
        [driftDatabase],
      );
      if (existing.length) throw new Error("disposable drift database already exists");
      let driftCreated = false;
      try {
        diagnosticPhase = "drift_create";
        await operator.query(`CREATE DATABASE \`${driftDatabase}\` CHARACTER SET utf8mb4`);
        driftCreated = true;
        const driftUrl = databaseUrl(base, driftDatabase);
        diagnosticPhase = "fresh_apply";
        const migrated = await MysqlSessionStore.connect({ url: driftUrl, connectionLimit: 2 });
        await migrated.close();
        diagnosticPhase = "weaken_check";
        const conn = await mysql.createConnection(driftUrl);
        try {
          await conn.query("ALTER TABLE sessions DROP CHECK chk_sessions_ordinary_delete_grace_shape");
          await conn.query(`ALTER TABLE sessions ADD CONSTRAINT chk_sessions_ordinary_delete_grace_shape
            CHECK (ordinary_delete_origin_sha256 IS NULL OR deleted_at_ms IS NOT NULL)`);
        } finally {
          await conn.end();
        }
        diagnosticPhase = "verify_reject";
        await expect(MysqlSessionStore.connect({ url: driftUrl, migrationMode: "verify" }))
          .rejects.toThrow(/0050 ordinary DELETE grace CHECK fingerprint is invalid/);
        diagnosticPhase = "apply_reject";
        await expect(MysqlSessionStore.connect({ url: driftUrl }))
          .rejects.toThrow(/0050 ordinary DELETE grace CHECK fingerprint is invalid/);
      } catch (error) {
        freezeDiagnostic();
        throw error;
      } finally {
        diagnosticPhase = "cleanup";
        try {
          if (driftCreated) await operator.query(`DROP DATABASE IF EXISTS \`${driftDatabase}\``);
        } finally {
          signal.removeEventListener("abort", freezeDiagnostic);
        }
      }
    });
  });
} else {
  describe("MysqlSessionStore ordinary DELETE grace", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 to exercise real InnoDB", () => {});
  });
}
