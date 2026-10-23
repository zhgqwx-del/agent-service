import { randomUUID } from "node:crypto";
import { DEFAULT_AUTH_POLICY, emptyUsage } from "@agent-service/protocol";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore, newUsageId, newErasureRequestId, userErasureRequestHash,
  tenantErasureRequestHash, EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  type ActivateTenantRestoreJournalControlInput, type RetentionPolicyDocumentV1 } from "../src/index.js";
import { mkSession, newId } from "./conformance.js";
import { CaptureMysqlRuntimeOwner } from "./fixtures/capture-mysql-runtime.js";
import { acquireFixtureSessionAuthority } from "./fixtures/session-authority.js";

const DAY = 86400000;
const BASE = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const policy = (duration: number | null): RetentionPolicyDocumentV1 => ({
  sessionContentRetentionMs: 30 * DAY, userErasureGraceMs: 30 * DAY, operationalUsageRetentionMs: duration,
  idempotencyReceiptRetentionMs: null, billingFactRetentionMs: null, lifecycleAuditRetentionMs: null, exportArtifactTtlMs: DAY,
});

type FixtureTask = { type: string; mode?: string; tasks?: readonly FixtureTask[];
  result?: { state: string; errors?: readonly unknown[]; retryCount?: number; repeatCount?: number; duration?: number } };
function successfulFixtureTasks(tasks: readonly FixtureTask[], expected: number): boolean {
  const leaves = (entries: readonly FixtureTask[]): FixtureTask[] => entries.flatMap(entry => entry.type === "suite" ? leaves(entry.tasks ?? []) : [entry]);
  const tests = leaves(tasks);
  return tests.length === expected && tests.every(task => task.type === "test" && task.mode === "run"
    && task.result?.state === "pass" && !task.result.errors?.length
    && (task.result.retryCount ?? 0) === 0 && (task.result.repeatCount ?? 0) === 0
    && typeof task.result.duration === "number" && task.result.duration <= 30_000);
}

async function finishOwned<T>(work: () => Promise<T>, close: () => Promise<void>): Promise<T> {
  let failed = false, firstError: unknown, value: T | undefined;
  try { value = await work(); } catch (error) { failed = true; firstError = error; }
  try { await close(); } catch (error) { if (!failed) { failed = true; firstError = error; } }
  if (failed) throw firstError;
  return value as T;
}

describe.runIf(Boolean(process.env.AGENT_SERVICE_INTEGRATION))("ordinary session usage retention atomic real MySQL", () => {
  let mysqlOwner: CaptureMysqlRuntimeOwner | undefined;
  let prepared = false;
  beforeAll(async () => {
    mysqlOwner = new CaptureMysqlRuntimeOwner(BASE, {
      tenantTelemetryRefKey: null,
      tenantTelemetryPersistedProviderCaptureLocalOnly: false,
      tenantTelemetryCaptureRestoreLocalOnly: false,
    }); // Own the new absent-witness DB and native preparation before the first await.
    await mysqlOwner.prepare();
    prepared = true;
  });
  afterAll(async ({}, suite) => {
    await mysqlOwner?.close({ successful: prepared && !suite.result?.errors?.length
      && successfulFixtureTasks(suite.tasks, 13) });
  });

  async function fixture(options: { duration?: number | null; configured?: boolean; ordinary?: boolean; empty?: boolean } = {}) {
    let clock = Date.now();
    let store = await mysqlOwner!.openStore(4);
    // Install only after real P1/P2 claims. Every synthetic-clock borrow still calls the
    // actual product guarded checkout (including native admission/reset) with its receiver.
    function installClock(target: MysqlSessionStore) {
      const pool = (target as unknown as { pool: Pool }).pool;
      const checkout = pool.getConnection.bind(pool);
      pool.getConnection = async () => { const conn = await checkout(); await conn.query("SET timestamp=?", [clock / 1000]); return conn; };
    }
    const conn = await mysqlOwner!.openInspection();
    const session = mkSession(`tenant-usage-retention-${randomUUID()}`, `user-usage-retention-${randomUUID()}`);
    await store.setTenantAuth(session.tenantId, DEFAULT_AUTH_POLICY);
    async function activate(duration: number | null, version: string = randomUUID()) {
      await store.putRetentionPolicy({ tenantId: session.tenantId, policyVersion: version,
        policy: policy(duration), actorKeyId: "admin", atMs: clock });
      const current = await store.getActiveRetentionPolicy(session.tenantId);
      await store.activateRetentionPolicy({ tenantId: session.tenantId, policyVersion: version,
        expectedControlGeneration: current?.control.controlGeneration ?? 0, actorKeyId: "admin", atMs: clock });
    }
    if (options.configured !== false) await activate(options.duration === undefined ? 0 : options.duration, "deletion-policy");
    await store.createSession(session);
    const p1 = await acquireFixtureSessionAuthority(store, session, 0);
    await finishOwned(async () => {
      if (!options.empty) await store.commit(p1.admit({ sessionId: session.id, fence: 1,
        usageEntries: [{ usageId: newUsageId(), turnId: newId("turn"), step: 1, provider: "provider", model: "model",
          usage: { ...emptyUsage(), inputTokens: 3, totalTokens: 3, costCNY: 2.5 }, createdAtMs: clock }],
      }));
    }, () => p1.release());
    // Empty usage still has the actual fixed predecessor P1. No numeric proof lookup or refresh.
    const p2 = await acquireFixtureSessionAuthority(store, session, 1);
    await finishOwned(async () => {
      // Policy publication/claims used real DB time. Anchor the original fixed SQL clock
      // after those native operations so the policy's DB-time floor cannot be in its future.
      clock = Date.now();
      installClock(store);
      await (options.ordinary === false ? store.commit.bind(store) : store.commitOrdinarySessionDelete.bind(store))(p2.admit({
        sessionId: session.id, fence: 2, lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: session.userId,
          atMs: clock, purgeAfterMs: null, deletionGeneration: 1 },
        events: [{ type: "session/deleted", sessionId: session.id, emittedAtMs: clock, deletionGeneration: 1 }],
      }));
    }, () => p2.release());
    await store.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id);
    const owner = { tenantId: session.tenantId, userId: session.userId, sessionId: session.id, deletionGeneration: 1 };
    const reconciliation = await store.reconcileSessionUsage({ ...owner, nowMs: clock });
    const input = { ...owner, expectedChecksum: reconciliation.checksum, enabled: true as const };
    async function activatePrimary(originalInput: ActivateTenantRestoreJournalControlInput) {
      // The owner joins every old Y pool, retires its real account, applies the original
      // primary input on an operator connection, and confirms the same fixed command.
      await mysqlOwner!.activatePrimary(originalInput);
      store = await mysqlOwner!.openStore(4);
      installClock(store); // Same clock value; the final assertion must use the new restricted Z pool.
    }
    return { get store() { return store; }, conn, session, input, activate, activatePrimary,
      now: () => clock, advance: (v: number) => { clock += v; }, setClock: (v: number) => { clock = v; },
      close: async () => finishOwned(() => conn.end(), () => store.close()) };
  }
  async function intact(f: Awaited<ReturnType<typeof fixture>>) {
    const [rows] = await f.conn.query<RowDataPacket[]>(
      "SELECT (SELECT COUNT(*) FROM usage_ledger WHERE session_id=?) AS n,(SELECT status FROM usage_reconciliations WHERE session_id=? AND deletion_generation=1) AS state,ordinary_usage_retention_receipt_json AS receipt FROM sessions WHERE session_id=?",
      [f.session.id, f.session.id, f.session.id]);
    expect(rows[0]).toMatchObject({ n: 1, state: "verified", receipt: null });
  }

  it("uses real DB time and commits exact receipt/row deletion with retained billing under concurrent retries", async () => {
    const f = await fixture();
    try {
      const [before] = await f.conn.query<RowDataPacket[]>("SELECT * FROM billing_usage_facts WHERE tenant_id=?", [f.session.tenantId]);
      expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).toBeNull();
      f.advance(31 * DAY);
      expect(await f.store.listOrdinarySessionUsageRetentionCandidates({ limit: 100 })).toContainEqual({
        tenantId: f.session.tenantId, userId: f.session.userId, sessionId: f.session.id, deletionGeneration: 1 });
      const [a, b] = await Promise.all([f.store.executeOrdinarySessionUsageRetention(f.input), f.store.executeOrdinarySessionUsageRetention(f.input)]);
      expect(a).not.toBeNull(); expect(b).toEqual(a);
      const [after] = await f.conn.query<RowDataPacket[]>("SELECT * FROM billing_usage_facts WHERE tenant_id=?", [f.session.tenantId]);
      expect(after).toEqual(before);
      const [ledger] = await f.conn.query<RowDataPacket[]>("SELECT * FROM usage_ledger WHERE session_id=?", [f.session.id]); expect(ledger).toEqual([]);
      expect((await f.store.getLifecycleOutbox("session.purge", f.session.id, 1))?.availableAtMs).toBeUndefined();
      expect(await f.store.getSessionLifecycle(f.session.tenantId, f.session.userId, f.session.id)).not.toBeNull();
    } finally { await f.close(); }
  });

  it.each([90 * DAY, null])("keeps deletion-time %s policy under a later shorter policy", async (duration) => {
    const f = await fixture({ duration }); try {
      f.advance(31 * DAY); await f.activate(0);
      expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).toBeNull(); await intact(f);
      if (duration !== null) { f.advance(60 * DAY); expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).not.toBeNull(); }
    } finally { await f.close(); }
  });

  it("uses the maximum current policy, and current NULL never authorizes expiry", async () => {
    const f = await fixture(); try {
      f.advance(31 * DAY); await f.activate(90 * DAY);
      expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).toBeNull();
      f.advance(60 * DAY); await f.activate(null);
      expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).toBeNull(); await intact(f);
    } finally { await f.close(); }
  });

  it.each([{ configured: false }, { ordinary: false }])("cannot later bind unconfigured/legacy source %j", async (options) => {
    const f = await fixture(options); try {
      f.advance(31 * DAY); await f.activate(0);
      expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).toBeNull(); await intact(f);
      expect(await f.store.listOrdinarySessionUsageRetentionCandidates({ limit: 100 })).not.toContainEqual({
        tenantId: f.session.tenantId, userId: f.session.userId, sessionId: f.session.id, deletionGeneration: 1 });
    } finally { await f.close(); }
  });

  it("rolls back after a receipt SQL failure and after a final publish-clock rollback", async () => {
    const f = await fixture(); try {
      f.advance(31 * DAY);
      await f.conn.query("CREATE TRIGGER test_usage_retention_rollback BEFORE UPDATE ON sessions FOR EACH ROW BEGIN IF NEW.ordinary_usage_retention_receipt_json IS NOT NULL AND OLD.session_id='" + f.session.id + "' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected receipt failure'; END IF; END");
      await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(/injected receipt failure/); await intact(f);
      await f.conn.query("DROP TRIGGER test_usage_retention_rollback");
      // A real SQL clock mutation after receipt publication; the store's final SQL time recheck
      // must roll back deletion, reconciliation and receipt together.
      const pool = (f.store as unknown as { pool: Pool }).pool;
      const checkout = pool.getConnection.bind(pool);
      pool.getConnection = async () => {
        const conn = await checkout(); const query = conn.query.bind(conn);
        conn.query = (async (...args: unknown[]) => {
          const result = await (query as (...v: unknown[]) => Promise<unknown>)(...args);
          if (typeof args[0] === "string" && args[0].startsWith("UPDATE sessions SET ordinary_usage_retention_receipt_json=")) await query("SET timestamp=1");
          return result;
        }) as typeof conn.query;
        return conn;
      };
      await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(/publish clock regressed/); await intact(f);
    } finally { await f.conn.query("DROP TRIGGER IF EXISTS test_usage_retention_rollback"); await f.close(); }
  });

  it("serializes a concurrent canonical hold before destruction, after a candidate scan", async () => {
    const f = await fixture(); try {
      f.advance(31 * DAY);
      expect(await f.store.listOrdinarySessionUsageRetentionCandidates({ limit: 100 })).toContainEqual({
        tenantId: f.session.tenantId, userId: f.session.userId, sessionId: f.session.id, deletionGeneration: 1 });
      await f.conn.beginTransaction();
      await f.conn.query("SELECT * FROM subject_lifecycle WHERE tenant_id=? AND subject_kind='user' AND subject_id=? FOR UPDATE", [f.session.tenantId, f.session.userId]);
      const hold = f.store.setLegalHold({ tenantId: f.session.tenantId, subjectKind: "user", subjectId: f.session.userId,
        holdId: `hold_${randomUUID()}`, reasonCode: "litigation", expectedControlGeneration: 0, actorKeyId: "admin", atMs: f.now() });
      // Release the owner lock and await the true canonical transaction before invoking execute.
      // The second test actor is independent from the executor's connection and scan snapshot.
      await f.conn.commit(); await hold;
      expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).toBeNull(); await intact(f);
    } finally { await f.close(); }
  });

  it.each(["tenant", "user"] as const)("rechecks %s erasure admitted after the scan", async (kind) => {
    const f = await fixture(); try {
      f.advance(31 * DAY); await f.store.listOrdinarySessionUsageRetentionCandidates({ limit: 100 });
      if (kind === "tenant") await f.store.requestTenantErasure({ requestId: newErasureRequestId(), tenantId: f.session.tenantId,
        requestedByKeyId: "admin", idempotencyKey: randomUUID(), requestHash: tenantErasureRequestHash(f.session.tenantId), atMs: f.now() });
      else await f.store.requestUserErasure({ requestId: newErasureRequestId(), tenantId: f.session.tenantId, userId: f.session.userId,
        requestedByKeyId: "admin", idempotencyKey: randomUUID(), requestHash: userErasureRequestHash(f.session.tenantId, f.session.userId), atMs: f.now() });
      await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(); await intact(f);
    } finally { await f.close(); }
  });

  it("SQL guards reject missing keys, wrong JSON types, extra payload and bidirectional partial evidence", async () => {
    const f = await fixture(); try {
      const [rows] = await f.conn.query<RowDataPacket[]>("SELECT ordinary_usage_retention_source_json AS source FROM sessions WHERE session_id=?", [f.session.id]);
      const source = rows[0]!.source as Record<string, unknown>;
      for (const key of ["schemaVersion", "originSha256", "policyVersion", "policySha256"]) {
        const missing = { ...source }; delete missing[key];
        await expect(f.conn.query("UPDATE sessions SET ordinary_usage_retention_source_json=? WHERE session_id=?", [JSON.stringify(missing), f.session.id]))
          .rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION", sqlMessage: "ordinary usage retention source shape invalid" });
      }
      for (const wrong of [{ schemaVersion: "2" }, { schemaVersion: true }, { originSha256: 42 },
        { policyVersion: 1 }, { policySha256: false }, { rawPayload: "not-allowed" }]) {
        await expect(f.conn.query("UPDATE sessions SET ordinary_usage_retention_source_json=? WHERE session_id=?", [JSON.stringify({ ...source, ...wrong }), f.session.id]))
          .rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION", sqlMessage: "ordinary usage retention source shape invalid" });
      }
      await expect(f.conn.query("UPDATE sessions SET ordinary_usage_retention_source_json=NULL WHERE session_id=?", [f.session.id]))
        .rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION", sqlMessage: "ordinary usage retention partial evidence" });
      await expect(f.conn.query("UPDATE sessions SET ordinary_usage_retention_source_sha256=NULL WHERE session_id=?", [f.session.id]))
        .rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION", sqlMessage: "ordinary usage retention partial evidence" });
      f.advance(31 * DAY); const receipt = (await f.store.executeOrdinarySessionUsageRetention(f.input))!;
      for (const key of ["schemaVersion", "sourceSha256", "sealSha256", "checksum", "facts"]) {
        const missing = { ...receipt } as Record<string, unknown>; delete missing[key];
        await expect(f.conn.query("UPDATE sessions SET ordinary_usage_retention_receipt_json=? WHERE session_id=?", [JSON.stringify(missing), f.session.id]))
          .rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION", sqlMessage: "ordinary usage retention receipt shape invalid" });
      }
      for (const wrong of [{ schemaVersion: "1" }, { sourceSha256: false }, { currentPolicyVersion: null },
        { deadlineDbMs: String(receipt.deadlineDbMs) }, { allDomainsComplete: true },
        { facts: [{ ...receipt.facts[0], secret: "not-allowed" }] }]) {
        await expect(f.conn.query("UPDATE sessions SET ordinary_usage_retention_receipt_json=? WHERE session_id=?", [JSON.stringify({ ...receipt, ...wrong }), f.session.id]))
          .rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION", sqlMessage: "ordinary usage retention receipt shape invalid" });
      }
      await expect(f.conn.query("UPDATE sessions SET ordinary_usage_retention_receipt_sha256=NULL WHERE session_id=?", [f.session.id]))
        .rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION", sqlMessage: "ordinary usage retention partial evidence" });
      expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).toEqual(receipt);
    } finally { await f.close(); }
  });

  it("independently verifies owner/generation/retained facts, including a zero-fact receipt", async () => {
    const f = await fixture(); const empty = await fixture({ empty: true }); try {
      f.advance(31 * DAY); empty.advance(31 * DAY);
      for (const altered of [{ tenantId: "other" }, { userId: "other" }, { deletionGeneration: 2 }, { expectedChecksum: "f".repeat(64) }]) {
        await expect(f.store.executeOrdinarySessionUsageRetention({ ...f.input, ...altered })).rejects.toThrow();
      }
      const receipt = (await f.store.executeOrdinarySessionUsageRetention(f.input))!;
      const emptyReceipt = await empty.store.executeOrdinarySessionUsageRetention(empty.input);
      expect(emptyReceipt?.facts).toEqual([]);
      expect(await empty.store.executeOrdinarySessionUsageRetention(empty.input)).toEqual(emptyReceipt);
      await f.conn.query("UPDATE usage_reconciliations SET anonymized_at_ms=anonymized_at_ms+1 WHERE session_id=? AND deletion_generation=1", [f.session.id]);
      await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(/exact replay changed/);
      await f.conn.query("UPDATE usage_reconciliations SET anonymized_at_ms=? WHERE session_id=? AND deletion_generation=1", [receipt.executedAtDbMs, f.session.id]);
      await f.conn.query("DELETE FROM billing_usage_facts WHERE usage_id=?", [receipt.facts[0]!.usageId]);
      await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(/billing fact missing/);
    } finally { await f.close(); await empty.close(); }
  });

  it("rechecks a real restore runtime activation and a backwards DB clock", async () => {
    // Runtime is global; use this last mutation test and rollback clock before restoring control.
    const f = await fixture(); try {
      f.setClock(1000);
      await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(/clock regressed/); await intact(f);
      f.setClock(Date.now() + 31 * DAY);
      const target = { targetOrdinal: 0, targetSha256: "a".repeat(64), failureDomainSha256: "b".repeat(64),
        adapterProtocol: "memory-restore-journal-v1", journalNamespaceSha256: "c".repeat(64) };
      await f.activatePrimary({ adapterProtocol: target.adapterProtocol,
        journalNamespaceSha256: target.journalNamespaceSha256, logicalDatabaseNamespaceSha256: "d".repeat(64), runtimeEpochSha256: "e".repeat(64),
        targets: [target], observedHeads: [{ ...target, logicalDatabaseNamespaceSha256: "d".repeat(64), sealedRemoteSequence: 0,
          sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256 }] });
      await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(/erasure\/restore gate/); await intact(f);
    } finally { await f.close(); }
  });
});
