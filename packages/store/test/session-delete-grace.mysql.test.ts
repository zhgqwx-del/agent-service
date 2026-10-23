import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachSessionWriteAdmission, SkillRegistryIntegrityError, SessionAuthorityConflictError, MysqlSessionStore, ORDINARY_SESSION_DELETE_GRACE_MS, SessionGoneError } from "../src/index.js";
import { mkSession } from "./conformance.js";
import { CurrentMysqlRuntimeOwner } from "./fixtures/current-mysql-runtime.js";
import { acquireFixtureSessionAuthority } from "./fixtures/session-authority.js";

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

type Writer = Awaited<ReturnType<typeof acquireFixtureSessionAuthority>>;

async function ordinaryDelete(store: MysqlSessionStore, session: ReturnType<typeof mkSession>, writer: Writer) {
  const atMs = Date.now();
  return store.commitOrdinarySessionDelete(writer.admit({
    sessionId: session.id, fence: 1,
    lifecycle: {
      type: "tombstone", tenantId: session.tenantId, userId: session.userId,
      atMs, purgeAfterMs: null, deletionGeneration: 1,
    },
    events: [{ type: "session/deleted", sessionId: session.id,
      emittedAtMs: atMs, deletionGeneration: 1 }],
  }));
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore ordinary DELETE grace", () => {
    let mysqlOwner: CurrentMysqlRuntimeOwner | undefined;
    beforeAll(async () => {
      mysqlOwner = new CurrentMysqlRuntimeOwner(disposableBase(BASE_MYSQL_URL).toString());
      await mysqlOwner.prepare();
    });
    afterAll(async ({}, suite) => {
      type Collected = { type: string; tasks?: readonly Collected[]; result?: { state?: string } };
      const tests: Collected[] = [];
      const collect = (tasks: readonly Collected[]) => { for (const task of tasks) {
        if (task.type === "test") tests.push(task); else if (task.tasks) collect(task.tasks);
      } };
      collect(suite.tasks);
      await mysqlOwner?.close({ successful: tests.length > 0 && tests.every(test => test.result?.state === "pass") });
    });

    it("atomically writes origin and serializes concurrent post-COMMIT seals", async () => {
      const first = await mysqlOwner!.openStore(4);
      const second = await mysqlOwner!.openStore(4);
      const conn = await mysqlOwner!.openInspection();
      const session = mkSession(`tenant-grace-${randomUUID()}`, `user-grace-${randomUUID()}`);
      try {
        await first.createSession(session);
        expect(await first.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id)).toBeNull();
        const writer = await acquireFixtureSessionAuthority(first, session, 0);
        const result = await ordinaryDelete(first, session, writer);
        await writer.release();
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
      const store = await mysqlOwner!.openStore(2);
      const conn = await mysqlOwner!.openInspection();
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
        const ordinaryWriter = await acquireFixtureSessionAuthority(store, ordinary, 0);
        await ordinaryDelete(store, ordinary, ordinaryWriter);
        await ordinaryWriter.release();
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
        const legacyWriter = await acquireFixtureSessionAuthority(store, legacy, 0);
        await store.commit(legacyWriter.admit({
          sessionId: legacy.id, fence: 1,
          lifecycle: { type: "tombstone", tenantId: legacy.tenantId, userId: legacy.userId,
            atMs, purgeAfterMs: null, deletionGeneration: 1 },
          events: [{ type: "session/deleted", sessionId: legacy.id,
            emittedAtMs: atMs, deletionGeneration: 1 }],
        }));
        await legacyWriter.release();
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
      const store = await mysqlOwner!.openStore(2);
      const session = mkSession(`tenant-grace-forge-${randomUUID()}`,
        `user-grace-forge-${randomUUID()}`);
      try {
        await store.createSession(session);
        const atMs = Date.now();
        const writer = await acquireFixtureSessionAuthority(store, session, 0);
        const forged = {
          sessionId: session.id, fence: 1,
          lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: session.userId,
            atMs, purgeAfterMs: null, deletionGeneration: 1,
            ordinaryDeleteGraceOrigin: true },
          events: [{ type: "session/deleted", sessionId: session.id,
            emittedAtMs: atMs, deletionGeneration: 1 }],
        } as unknown as Parameters<MysqlSessionStore["commit"]>[0];
        await expect(store.commit(writer.admit(forged))).rejects.toThrow(/not accepted/);
        expect((await store.readEvents(session.id, 0, 10)).map((event) => event.type))
          .toEqual(["session/created"]);
        expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
          .toBeNull();
        await expect(store.commitOrdinarySessionDelete(writer.admit({
          ...forged,
          lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: "wrong-user",
            atMs, purgeAfterMs: null, deletionGeneration: 1 },
        }))).rejects.toBeInstanceOf(SessionGoneError);
        expect((await store.readEvents(session.id, 0, 10)).map((event) => event.type))
          .toEqual(["session/created"]);
        await ordinaryDelete(store, session, writer);
        await writer.release();
        expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
          .toMatchObject({ state: "unknown", executionReady: false });
        await store.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id);
      } finally {
        await store.close();
      }
    });

    it("rolls back origin with terminal write failure, and can retry a failed seal exactly", async () => {
      const store = await mysqlOwner!.openStore(3);
      const conn = await mysqlOwner!.openInspection();
      const session = mkSession(`tenant-grace-${randomUUID()}`, `user-grace-${randomUUID()}`);
      const trigger = `test_grace_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      try {
        await store.createSession(session);
        const writer = await acquireFixtureSessionAuthority(store, session, 0);
        await conn.query(`CREATE TRIGGER \`${trigger}\` BEFORE UPDATE ON sessions FOR EACH ROW
          BEGIN IF NEW.session_id=? AND NEW.ordinary_delete_origin_sha256 IS NOT NULL
             AND NEW.ordinary_delete_seal_sha256 IS NULL THEN
             SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected grace origin failure';
          END IF; END`, [session.id]);
        await expect(ordinaryDelete(store, session, writer)).rejects.toThrow(/injected grace origin failure/);
        expect((await store.readEvents(session.id, 0, 10)).map((event) => event.type))
          .toEqual(["session/created"]);
        expect(await store.getLifecycleOutbox("session.purge", session.id, 1)).toBeNull();
        const [before] = await conn.query<RowDataPacket[]>(
          "SELECT ordinary_delete_origin_sha256,deleted_at_ms,last_seq,fence_token FROM sessions WHERE session_id=?",
          [session.id],
        );
        expect(before[0]).toMatchObject({ ordinary_delete_origin_sha256: null,
          deleted_at_ms: null, last_seq: 1, fence_token: 1 });
        await conn.query(`DROP TRIGGER \`${trigger}\``);
        await ordinaryDelete(store, session, writer);
        await writer.release();
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
      const first = await mysqlOwner!.openStore(3);
      const second = await mysqlOwner!.openStore(3);
      const conn = await mysqlOwner!.openInspection();
      const session = mkSession(`tenant-grace-race-${randomUUID()}`, `user-grace-race-${randomUUID()}`);
      try {
        await first.createSession(session);
        // Both clients submit under one real P1, so this remains a tombstone race, not an acquire race.
        const writer = await acquireFixtureSessionAuthority(first, session, 0);
        const results = await Promise.allSettled([
          ordinaryDelete(first, session, writer), ordinaryDelete(second, session, writer),
        ]);
        await writer.release();
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const failure = results.find((result) => result.status === "rejected");
        expect(failure && "reason" in failure ? failure.reason : null).toBeInstanceOf(SessionAuthorityConflictError);
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
        // Full rows of the affected canonical projections, read independently of Store validators.
        const snapshot = async () => {
          const state: Record<string, unknown> = {};
          for (const [table, column, value, order] of [
            ["sessions", "session_id", session.id, "session_id"],
            ["events", "session_id", session.id, "seq"],
            ["items", "session_id", session.id, "item_id"],
            ["turns", "session_id", session.id, "turn_id"],
            ["approvals", "session_id", session.id, "approval_id"],
            ["usage_ledger", "session_id", session.id, "id"],
            ["usage_reconciliations", "session_id", session.id, "deletion_generation"],
            ["lifecycle_outbox", "aggregate_id", session.id, "topic,generation"],
            ["subject_lifecycle", "tenant_id", session.tenantId, "subject_kind,subject_id"],
            ["billing_usage_facts", "tenant_id", session.tenantId, "usage_id"],
          ] as const) {
            const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${table} WHERE ${column}=? ORDER BY ${order}`, [value]);
            state[table] = rows;
          }
          return state;
        };
        const canonical = await snapshot();
        const cold = await mysqlOwner!.openStore(2);
        try {
          expect(await cold.getSessionLifecycle(session.tenantId, session.userId, session.id))
            .toEqual(await first.getSessionLifecycle(session.tenantId, session.userId, session.id));
          expect(await cold.readEvents(session.id, 0, 10)).toEqual(await first.readEvents(session.id, 0, 10));
          await expect(ordinaryDelete(second, session, writer)).rejects.toBeInstanceOf(SessionAuthorityConflictError);
          expect(await snapshot()).toEqual(canonical);
        } finally { await cold.close(); }
      } finally {
        await conn.end();
        await first.close();
        await second.close();
      }
    });

    it("rolls back if a trigger silently strips the ordinary origin before commit", async () => {
      const store = await mysqlOwner!.openStore(3);
      const conn = await mysqlOwner!.openInspection();
      const session = mkSession(`tenant-grace-strip-${randomUUID()}`,
        `user-grace-strip-${randomUUID()}`);
      const trigger = `test_grace_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      try {
        await store.createSession(session);
        const writer = await acquireFixtureSessionAuthority(store, session, 0);
        await conn.query(`CREATE TRIGGER \`${trigger}\` BEFORE UPDATE ON sessions FOR EACH ROW
          BEGIN IF NEW.session_id=? AND NEW.ordinary_delete_origin_sha256 IS NOT NULL THEN
            SET NEW.ordinary_delete_origin_sha256=NULL;
            SET NEW.ordinary_delete_origin_observed_db_ms=NULL;
          END IF; END`, [session.id]);
        await expect(ordinaryDelete(store, session, writer)).rejects.toThrow(/origin was not published/);
        expect((await store.readEvents(session.id, 0, 10)).map((event) => event.type))
          .toEqual(["session/created"]);
        expect(await store.getLifecycleOutbox("session.purge", session.id, 1)).toBeNull();
        expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
          .toBeNull();
        await writer.release();
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
      const driftOwner = new CurrentMysqlRuntimeOwner(disposableBase(BASE_MYSQL_URL).toString());
      let driftPassed = false;
      try {
        diagnosticPhase = "drift_create";
        await driftOwner.prepare();
        const driftUrl = databaseUrl(disposableBase(BASE_MYSQL_URL), driftOwner.database);
        diagnosticPhase = "fresh_apply";
        const migrated = await driftOwner.openStore(2, signal);
        await migrated.close();
        diagnosticPhase = "weaken_check";
        const conn = await driftOwner.openInspection(signal);
        try {
          // Capture the verified current CHECK verbatim. A successful negative restores only this
          // exact definition, allowing the fixture owner to verify and clean its own fresh schema.
          const [checks] = await conn.query<RowDataPacket[]>(
            "SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? AND CONSTRAINT_NAME='chk_sessions_ordinary_delete_grace_shape'",
            [driftOwner.database],
          );
          expect(checks).toHaveLength(1);
          expect(typeof checks[0]?.CHECK_CLAUSE).toBe("string");
          const originalCheck = String(checks[0]?.CHECK_CLAUSE);
          await conn.query("ALTER TABLE sessions DROP CHECK chk_sessions_ordinary_delete_grace_shape");
          await conn.query(`ALTER TABLE sessions ADD CONSTRAINT chk_sessions_ordinary_delete_grace_shape
            CHECK (ordinary_delete_origin_sha256 IS NULL OR deleted_at_ms IS NOT NULL)`);
          // Current 0066's complete selected root is checked before the dedicated 0050 kernel.
          // Keep exact startup first-error and independently exercise that unchanged real kernel.
          const verifyGrace = Reflect.get(migrated, "assertOrdinarySessionDeleteGraceFingerprint");
          expect(typeof verifyGrace).toBe("function");
          await expect(Reflect.apply(verifyGrace, migrated, [conn]))
            .rejects.toThrow(/0050 ordinary DELETE grace CHECK fingerprint is invalid/);
          diagnosticPhase = "verify_reject";
          await expect(driftOwner.openStore(2, signal))
            .rejects.toBeInstanceOf(SkillRegistryIntegrityError);
          diagnosticPhase = "apply_reject";
          await expect(MysqlSessionStore.runSchemaOperation({ url: driftUrl, operation: "migrate",
            fleetStoppedAck: "all-application-writers-stopped-v1", operationAbortSignal: signal }))
            .rejects.toBeInstanceOf(SkillRegistryIntegrityError);
          await conn.query("ALTER TABLE sessions DROP CHECK chk_sessions_ordinary_delete_grace_shape");
          await conn.query(`ALTER TABLE sessions ADD CONSTRAINT chk_sessions_ordinary_delete_grace_shape CHECK (${originalCheck})`);
        } finally { await conn.end(); }
        driftPassed = true;
      } catch (error) {
        freezeDiagnostic();
        throw error;
      } finally {
        diagnosticPhase = "cleanup";
        try { await driftOwner.close({ successful: driftPassed }); }
        finally { signal.removeEventListener("abort", freezeDiagnostic); }
      }
    });
  });
} else {
  describe("MysqlSessionStore ordinary DELETE grace", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 to exercise real InnoDB", () => {});
  });
}
