import { randomUUID } from "node:crypto";
import { emptyUsage, type Session } from "@agent-service/protocol";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ErasureTombstoneIntegrityError,
  MysqlSessionStore,
  UsageIdentityConflictError,
  billingUsageFactFromLedger,
  canonicalBillingCostCNY,
  newErasureRequestId,
  newUsageId,
  userErasureRequestHash,
  type BillingUsageFact,
  type ErasureJobAuthorization,
  type ErasureJobClaim,
  type ErasureRequestStatus,
  type ErasureWriteAuthorization,
  type UsageLedgerEntry,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create erasure usage fixture database from base database "${database}": `
      + "MYSQL_TEST_URL must name a test database",
    );
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function jobAuthorization(claim: ErasureJobClaim): ErasureJobAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectKind: claim.subjectKind,
    subjectId: claim.subjectId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

function writeAuthorization(claim: ErasureJobClaim): ErasureWriteAuthorization {
  if (claim.subjectKind !== "user") throw new Error("test requires a user erasure claim");
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    userId: claim.subjectId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

async function claimRequest(
  store: MysqlSessionStore,
  requestId: string,
  nowMs: number,
  claimToken: string,
  leaseMs = 600_000,
): Promise<ErasureJobClaim> {
  const claim = (await store.claimErasureJobs({ nowMs, limit: 100, leaseMs, claimToken }))
    .find((candidate) => candidate.requestId === requestId);
  if (!claim) throw new Error(`failed to claim erasure request ${requestId}`);
  return claim;
}

async function claimReconciling(
  store: MysqlSessionStore,
  session: Session,
  tokenPrefix: string,
  atMs = Date.now(),
): Promise<{ requestId: string; claim: ErasureJobClaim; authority: ErasureWriteAuthorization; nowMs: number }> {
  const requestId = newErasureRequestId();
  await store.requestUserErasure({
    requestId,
    tenantId: session.tenantId,
    userId: session.userId,
    requestedByKeyId: "admin-erasure-usage",
    idempotencyKey: `erase-${randomUUID()}`,
    requestHash: userErasureRequestHash(session.tenantId, session.userId),
    atMs,
  });
  let nowMs = atMs;
  let claim = await claimRequest(store, requestId, nowMs, `${tokenPrefix.slice(0, 24)}-gated`);
  for (const status of ["draining", "tombstoning", "reconciling_usage"] as const satisfies readonly ErasureRequestStatus[]) {
    nowMs += 1;
    expect(await store.transitionErasureJob(jobAuthorization(claim), {
      fromStatus: claim.status,
      toStatus: status,
      atMs: nowMs,
      availableAtMs: nowMs,
    })).toBe(true);
    claim = await claimRequest(
      store,
      requestId,
      nowMs,
      `${tokenPrefix.slice(0, 24)}-${status}`,
    );
  }
  return { requestId, claim, authority: writeAuthorization(claim), nowMs };
}

function usageEntry(
  session: Session,
  step: number,
  usageId?: string,
  model = "legacy-model",
): UsageLedgerEntry {
  return {
    ...(usageId === undefined ? {} : { usageId }),
    tenantId: session.tenantId,
    userId: session.userId,
    sessionId: session.id,
    turnId: newId("turn"),
    step,
    provider: "legacy-provider",
    model,
    usage: { ...emptyUsage(), inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    createdAtMs: Date.UTC(2026, 9, 1),
  };
}

async function insertUsage(conn: Connection, entry: UsageLedgerEntry): Promise<void> {
  await conn.query(
    `INSERT INTO usage_ledger
       (usage_id, tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      entry.usageId ?? null,
      entry.tenantId,
      entry.userId,
      entry.sessionId,
      entry.turnId,
      entry.step,
      entry.provider,
      entry.model,
      JSON.stringify(entry.usage),
      entry.createdAtMs,
    ],
  );
}

async function insertBillingFact(conn: Connection, fact: BillingUsageFact): Promise<void> {
  await conn.query(
    `INSERT INTO billing_usage_facts
       (usage_id, tenant_id, accounting_period, provider, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, cost_cny, currency,
        fact_sha256)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      fact.usageId,
      fact.tenantId,
      fact.accountingPeriod,
      fact.provider,
      fact.model,
      fact.inputTokens,
      fact.outputTokens,
      fact.cacheReadTokens,
      fact.cacheWriteTokens,
      fact.reasoningTokens,
      fact.totalTokens,
      fact.costCNY === undefined ? null : canonicalBillingCostCNY(fact.costCNY),
      fact.currency,
      fact.factSha256,
    ],
  );
}

async function tombstone(store: MysqlSessionStore, session: Session, generation = 1): Promise<void> {
  const atMs = Date.now();
  await store.commit({
    sessionId: session.id,
    fence: 1,
    lifecycle: {
      type: "tombstone",
      tenantId: session.tenantId,
      userId: session.userId,
      deletionGeneration: generation,
      atMs,
    },
    events: [{
      type: "session/deleted",
      sessionId: session.id,
      deletionGeneration: generation,
      emittedAtMs: atMs,
    }],
  });
}

async function expectStillPending<T>(promise: Promise<T>): Promise<void> {
  let state: "pending" | "settled" = "pending";
  void promise.then(
    () => { state = "settled"; },
    () => { state = "settled"; },
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(state).toBe("pending");
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 500): Promise<
  { timedOut: false; value: T } | { timedOut: true }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const result = await Promise.race([
    promise.then((value) => ({ timedOut: false as const, value })),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore claim-bound erasure usage reconciliation", () => {
    let admin: Connection | undefined;
    let mysqlUrl = "";
    let database = "";

    beforeAll(async () => {
      const base = assertDisposableTestTarget(BASE_MYSQL_URL);
      database = `agent_service_erasure_usage_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_erasure_usage_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe generated erasure usage fixture database name");
      }
      admin = await mysql.createConnection(databaseUrl(base, "mysql"));
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      mysqlUrl = databaseUrl(base, database);
      const migrated = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1 });
      await migrated.close();
    });

    afterAll(async () => {
      if (admin && database) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin?.end();
    });

    it("commits a legacy usage id, billing fact and reconciliation under one current claim", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(
        `tenant_erasure_usage_success_${randomUUID()}`,
        `user_${randomUUID()}`,
      );
      try {
        await store.createSession(session);
        await tombstone(store, session);
        const fixture = await claimReconciling(store, session, `usage-success-${randomUUID()}`);
        await insertUsage(conn, usageEntry(session, 1));

        const result = await store.reconcileErasureSessionUsage(fixture.authority, {
          sessionId: session.id,
          deletionGeneration: 1,
          nowMs: fixture.nowMs,
        });
        expect(result).toMatchObject({
          tenantId: session.tenantId,
          userId: session.userId,
          sessionId: session.id,
          deletionGeneration: 1,
          status: "verified",
          rowCount: 1,
          totalTokens: 3,
        });

        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT u.usage_id,
                  (SELECT COUNT(*) FROM billing_usage_facts b WHERE b.usage_id=u.usage_id) AS billing_count,
                  (SELECT COUNT(*) FROM usage_reconciliations r
                    WHERE r.session_id=u.session_id AND r.deletion_generation=1) AS reconciliation_count
             FROM usage_ledger u WHERE u.session_id=?`,
          [session.id],
        );
        expect(String(rows[0]?.usage_id)).toMatch(/^usg_/);
        expect(Number(rows[0]?.billing_count)).toBe(1);
        expect(Number(rows[0]?.reconciliation_count)).toBe(1);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rechecks authority after a call has started and rejects a same-token ABA takeover without writes", async () => {
      const firstStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const secondStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const blocker = await mysql.createConnection(mysqlUrl);
      const session = mkSession(
        `tenant_erasure_usage_aba_${randomUUID()}`,
        `user_${randomUUID()}`,
      );
      let blockerOpen = false;
      try {
        await firstStore.createSession(session);
        await tombstone(firstStore, session);
        const fixture = await claimReconciling(firstStore, session, `usage-aba-${randomUUID()}`);
        await insertUsage(conn, usageEntry(session, 1));

        await blocker.beginTransaction();
        blockerOpen = true;
        await blocker.query("SELECT session_id FROM sessions WHERE session_id=? FOR UPDATE", [session.id]);
        const started = firstStore.reconcileErasureSessionUsage(fixture.authority, {
          sessionId: session.id,
          deletionGeneration: 1,
          nowMs: fixture.nowMs + 1,
        });
        await expectStillPending(started);

        expect(await secondStore.retryErasureJob(jobAuthorization(fixture.claim), {
          failedAtMs: fixture.nowMs + 1,
          availableAtMs: fixture.nowMs + 1,
          errorCode: "temporary_failure",
        })).toBe(true);
        const replacement = await claimRequest(
          secondStore,
          fixture.requestId,
          fixture.nowMs + 1,
          // Deliberately reuse the token; the incremented attempt is the ABA discriminator.
          fixture.claim.claimToken,
        );
        expect(replacement.attempts).toBe(fixture.claim.attempts + 1);

        await blocker.commit();
        blockerOpen = false;
        await expect(started).rejects.toThrow("stale erasure authority");

        const [usageRows] = await conn.query<RowDataPacket[]>(
          "SELECT usage_id FROM usage_ledger WHERE session_id=?",
          [session.id],
        );
        const [billingRows] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS n FROM billing_usage_facts WHERE tenant_id=?",
          [session.tenantId],
        );
        const [reconciliationRows] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS n FROM usage_reconciliations WHERE session_id=?",
          [session.id],
        );
        expect(usageRows[0]?.usage_id).toBeNull();
        expect(Number(billingRows[0]?.n)).toBe(0);
        expect(Number(reconciliationRows[0]?.n)).toBe(0);

        // The same old authority is now stale before invocation as well, and the current claim
        // loses this capability immediately when its phase leaves reconciling_usage.
        await expect(firstStore.reconcileErasureSessionUsage(fixture.authority, {
          sessionId: session.id,
          deletionGeneration: 1,
          nowMs: fixture.nowMs + 2,
        })).rejects.toThrow("stale erasure authority");
        expect(await secondStore.transitionErasureJob(jobAuthorization(replacement), {
          fromStatus: "reconciling_usage",
          toStatus: "awaiting_purge_policy",
          atMs: fixture.nowMs + 2,
        })).toBe(true);
        await expect(secondStore.reconcileErasureSessionUsage(writeAuthorization(replacement), {
          sessionId: session.id,
          deletionGeneration: 1,
          nowMs: fixture.nowMs + 2,
        })).rejects.toThrow("stale erasure authority");
      } finally {
        if (blockerOpen) await blocker.rollback().catch(() => {});
        await blocker.end();
        await conn.end();
        await secondStore.close();
        await firstStore.close();
      }
    });

    it("does not wait on a different owner's locked session while checking proof scope", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const blocker = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_erasure_usage_scope_${randomUUID()}`;
      const target = mkSession(tenantId, `user_target_${randomUUID()}`);
      const hidden = mkSession(tenantId, `user_hidden_${randomUUID()}`);
      try {
        await store.createSession(target);
        await store.createSession(hidden);
        await tombstone(store, target);
        await tombstone(store, hidden);
        const fixture = await claimReconciling(store, target, `usage-scope-${randomUUID()}`);

        await blocker.beginTransaction();
        await blocker.query("SELECT session_id FROM sessions WHERE session_id=? FOR UPDATE", [hidden.id]);
        const attempted = store.reconcileErasureSessionUsage(fixture.authority, {
          sessionId: hidden.id,
          deletionGeneration: 1,
          nowMs: fixture.nowMs,
        }).then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        const outcome = await settleWithin(attempted);
        expect(outcome.timedOut).toBe(false);
        if (!outcome.timedOut) {
          expect(outcome.value.kind).toBe("rejected");
          if (outcome.value.kind === "rejected") {
            expect(outcome.value.error).toBeInstanceOf(ErasureTombstoneIntegrityError);
          }
        }
      } finally {
        await blocker.rollback().catch(() => {});
        await blocker.end();
        await store.close();
      }
    });

    it("rolls back legacy id assignment and earlier billing inserts when a later fact conflicts", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(
        `tenant_erasure_usage_rollback_${randomUUID()}`,
        `user_${randomUUID()}`,
      );
      try {
        await store.createSession(session);
        await tombstone(store, session);
        const fixture = await claimReconciling(store, session, `usage-rollback-${randomUUID()}`);
        const sortedUsageIds = [newUsageId(), newUsageId()].sort();
        const firstId = sortedUsageIds[0]!;
        const conflictId = sortedUsageIds[1]!;
        const first = usageEntry(session, 1, firstId);
        const legacy = usageEntry(session, 2);
        const conflict = usageEntry(session, 3, conflictId);
        await insertUsage(conn, first);
        await insertUsage(conn, legacy);
        await insertUsage(conn, conflict);
        await insertBillingFact(conn, billingUsageFactFromLedger({
          ...conflict,
          usageId: conflictId,
          model: "different-model",
        }));

        await expect(store.reconcileErasureSessionUsage(fixture.authority, {
          sessionId: session.id,
          deletionGeneration: 1,
          nowMs: fixture.nowMs,
        })).rejects.toBeInstanceOf(UsageIdentityConflictError);

        const [usageRows] = await conn.query<RowDataPacket[]>(
          "SELECT step, usage_id FROM usage_ledger WHERE session_id=? ORDER BY step",
          [session.id],
        );
        const [billingRows] = await conn.query<RowDataPacket[]>(
          "SELECT usage_id FROM billing_usage_facts WHERE tenant_id=? ORDER BY usage_id",
          [session.tenantId],
        );
        const [reconciliationRows] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS n FROM usage_reconciliations WHERE session_id=?",
          [session.id],
        );
        expect(usageRows.map((row) => row.usage_id)).toEqual([firstId, null, conflictId]);
        expect(billingRows.map((row) => row.usage_id)).toEqual([conflictId]);
        expect(Number(reconciliationRows[0]?.n)).toBe(0);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rejects a proof damaged after enumeration with zero usage, billing or reconciliation writes", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(
        `tenant_erasure_usage_proof_${randomUUID()}`,
        `user_${randomUUID()}`,
      );
      try {
        await store.createSession(session);
        await tombstone(store, session);
        const fixture = await claimReconciling(store, session, `usage-proof-${randomUUID()}`);
        await insertUsage(conn, usageEntry(session, 1));
        await conn.query(
          "UPDATE lifecycle_outbox SET attempts=1 WHERE aggregate_id=? AND topic='session.purge'",
          [session.id],
        );

        await expect(store.reconcileErasureSessionUsage(fixture.authority, {
          sessionId: session.id,
          deletionGeneration: 1,
          nowMs: fixture.nowMs,
        })).rejects.toBeInstanceOf(ErasureTombstoneIntegrityError);

        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT u.usage_id,
                  (SELECT COUNT(*) FROM billing_usage_facts b WHERE b.tenant_id=?) AS billing_count,
                  (SELECT COUNT(*) FROM usage_reconciliations r WHERE r.session_id=?) AS reconciliation_count
             FROM usage_ledger u WHERE u.session_id=?`,
          [session.tenantId, session.id, session.id],
        );
        expect(rows[0]?.usage_id).toBeNull();
        expect(Number(rows[0]?.billing_count)).toBe(0);
        expect(Number(rows[0]?.reconciliation_count)).toBe(0);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("holds proof rows through usage commit so concurrent proof damage cannot interleave", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const corrupter = await mysql.createConnection(mysqlUrl);
      const session = mkSession(
        `tenant_erasure_usage_proof_lock_${randomUUID()}`,
        `user_${randomUUID()}`,
      );
      let blockerOpen = false;
      try {
        await store.createSession(session);
        await tombstone(store, session);
        const fixture = await claimReconciling(store, session, `usage-proof-lock-${randomUUID()}`);
        await insertUsage(conn, usageEntry(session, 1));
        await conn.beginTransaction();
        blockerOpen = true;
        await conn.query(
          "SELECT outbox_id FROM lifecycle_outbox WHERE aggregate_id=? AND topic='session.purge' FOR UPDATE",
          [session.id],
        );

        const reconciling = store.reconcileErasureSessionUsage(fixture.authority, {
          sessionId: session.id,
          deletionGeneration: 1,
          nowMs: fixture.nowMs,
        });
        await expectStillPending(reconciling);
        const corrupting = corrupter.query(
          "UPDATE lifecycle_outbox SET attempts=1 WHERE aggregate_id=? AND topic='session.purge'",
          [session.id],
        );
        await expectStillPending(corrupting);

        await conn.commit();
        blockerOpen = false;
        await expect(reconciling).resolves.toMatchObject({ status: "verified", rowCount: 1 });
        await expect(corrupting).resolves.toBeDefined();
      } finally {
        if (blockerOpen) await conn.rollback().catch(() => {});
        await corrupter.end();
        await conn.end();
        await store.close();
      }
    });

    it("rolls back proof-validated usage writes when the final reconciliation insert fails", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(
        `tenant_erasure_usage_trigger_${randomUUID()}`,
        `user_${randomUUID()}`,
      );
      const trigger = `erasure_usage_fail_${randomUUID().replaceAll("-", "")}`;
      try {
        await store.createSession(session);
        await tombstone(store, session);
        const fixture = await claimReconciling(store, session, `usage-trigger-${randomUUID()}`);
        await insertUsage(conn, usageEntry(session, 1));
        await conn.query(
          `CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON usage_reconciliations
             FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected reconciliation failure'`,
        );

        await expect(store.reconcileErasureSessionUsage(fixture.authority, {
          sessionId: session.id,
          deletionGeneration: 1,
          nowMs: fixture.nowMs,
        })).rejects.toThrow("injected reconciliation failure");

        const [usageRows] = await conn.query<RowDataPacket[]>(
          "SELECT usage_id FROM usage_ledger WHERE session_id=?",
          [session.id],
        );
        const [billingRows] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS n FROM billing_usage_facts WHERE tenant_id=?",
          [session.tenantId],
        );
        const [reconciliationRows] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS n FROM usage_reconciliations WHERE session_id=?",
          [session.id],
        );
        expect(usageRows[0]?.usage_id).toBeNull();
        expect(Number(billingRows[0]?.n)).toBe(0);
        expect(Number(reconciliationRows[0]?.n)).toBe(0);
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``).catch(() => {});
        await conn.end();
        await store.close();
      }
    });
  });
}
