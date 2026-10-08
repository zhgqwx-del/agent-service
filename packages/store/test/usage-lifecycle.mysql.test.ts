import { randomUUID } from "node:crypto";
import { emptyUsage, type Session, type Usage } from "@agent-service/protocol";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MysqlSessionStore,
  SessionGoneError,
  UsageAnonymizationDisabledError,
  UsageIdentityConflictError,
  UsageLegalHoldError,
  UsageLifecycleGenerationError,
  UsageReconciliationError,
  billingUsageFactFromLedger,
  canonicalBillingCostCNY,
  isUsageId,
  newLegalHoldId,
  newUsageId,
  type BillingUsageFact,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const MONTH_START = Date.UTC(2026, 0, 1);

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create usage lifecycle fixture database from base database "${database}": `
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

async function ensureSubjectLifecycle(conn: Connection, session: Session): Promise<void> {
  const now = session.createdAtMs;
  await conn.query(
    `INSERT INTO subject_lifecycle
       (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
        legal_hold_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, 'tenant', ?, 'active', 0, NULL, NULL, ?, ?)
     ON DUPLICATE KEY UPDATE subject_id=subject_lifecycle.subject_id`,
    [session.tenantId, session.tenantId, now, now],
  );
  await conn.query(
    `INSERT INTO subject_lifecycle
       (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
        legal_hold_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, 'user', ?, 'active', 0, NULL, NULL, ?, ?)
     ON DUPLICATE KEY UPDATE subject_id=subject_lifecycle.subject_id`,
    [session.tenantId, session.userId, now, now],
  );
}

async function createSession(
  store: MysqlSessionStore,
  conn: Connection,
  tenantId = `tenant_usage_${randomUUID()}`,
  userId = `user_usage_${randomUUID()}`,
): Promise<Session> {
  const session = mkSession(tenantId, userId);
  await store.createSession(session);
  await ensureSubjectLifecycle(conn, session);
  return session;
}

async function tombstone(store: MysqlSessionStore, session: Session, generation = 1): Promise<void> {
  const current = await store.getSessionLifecycle(session.tenantId, session.userId, session.id);
  if (!current) throw new Error("test session disappeared before tombstone");
  const atMs = MONTH_START + 100 + generation;
  await store.commit({
    sessionId: session.id,
    fence: current.session.fenceToken + 1,
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

function usage(overrides: Partial<Usage> = {}): Usage {
  return { ...emptyUsage(), inputTokens: 2, outputTokens: 1, totalTokens: 3, costCNY: undefined, ...overrides };
}

async function insertLegacyUsage(
  conn: Connection,
  session: Session,
  options: {
    usageId?: string;
    tenantId?: string;
    userId?: string;
    turnId?: string;
    step?: number;
    provider?: string;
    model?: string;
    usage?: Usage;
    createdAtMs?: number;
  } = {},
): Promise<void> {
  await conn.query(
    `INSERT INTO usage_ledger
       (usage_id, tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      options.usageId ?? null,
      options.tenantId ?? session.tenantId,
      options.userId ?? session.userId,
      session.id,
      options.turnId ?? newId("turn"),
      options.step ?? 1,
      options.provider ?? "legacy-provider",
      options.model ?? "legacy-model",
      JSON.stringify(options.usage ?? usage()),
      options.createdAtMs ?? MONTH_START,
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

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore usage billing lifecycle", () => {
    let admin: Connection | undefined;
    let mysqlUrl = "";
    let database = "";

    beforeAll(async () => {
      const base = assertDisposableTestTarget(BASE_MYSQL_URL);
      database = `agent_service_usage_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_usage_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe generated usage lifecycle fixture database name");
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

    it("dual-writes whitelisted billing facts and preserves unknown versus known-zero cost", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const unknown = await createSession(store, conn);
      const knownZero = await createSession(store, conn, unknown.tenantId, `${unknown.userId}_zero`);
      const mixed = await createSession(store, conn, unknown.tenantId, `${unknown.userId}_mixed`);
      const unknownId = newUsageId();
      const zeroId = newUsageId();
      try {
        await store.commit({
          sessionId: unknown.id,
          fence: 1,
          usageEntries: [{
            usageId: unknownId,
            turnId: newId("turn"),
            step: 1,
            provider: "provider-a",
            model: "model-a",
            usage: usage(),
            createdAtMs: MONTH_START,
          }],
        });
        await store.commit({
          sessionId: knownZero.id,
          fence: 1,
          usageEntries: [{
            usageId: zeroId,
            turnId: newId("turn"),
            step: 1,
            provider: "provider-a",
            model: "model-a",
            usage: usage({ costCNY: 0 }),
            createdAtMs: MONTH_START,
          }],
        });
        await store.commit({
          sessionId: mixed.id,
          fence: 1,
          usageEntries: [
            {
              usageId: newUsageId(),
              turnId: newId("turn"),
              step: 1,
              provider: "provider-a",
              model: "model-a",
              // Zero token counters do not make a real unpriced row an aggregation identity.
              usage: { ...emptyUsage(), costCNY: undefined },
              createdAtMs: MONTH_START,
            },
            {
              usageId: newUsageId(),
              turnId: newId("turn"),
              step: 2,
              provider: "provider-a",
              model: "model-a",
              usage: usage({ costCNY: 0 }),
              createdAtMs: MONTH_START,
            },
          ],
        });
        // Historical JSON may contain an explicit null. It is unknown, not a priced zero row.
        await insertLegacyUsage(conn, unknown, {
          step: 2,
          usage: { ...usage(), costCNY: null } as unknown as Usage,
        });

        expect((await store.queryUsage(unknown.tenantId, {
          sessionId: unknown.id, groupBy: "total", limit: 10,
        })).data[0]?.usage.costCNY).toBeUndefined();
        expect((await store.queryUsage(knownZero.tenantId, {
          sessionId: knownZero.id, groupBy: "total", limit: 10,
        })).data[0]?.usage.costCNY).toBe(0);
        expect((await store.queryUsage(mixed.tenantId, {
          sessionId: mixed.id, groupBy: "total", limit: 10,
        })).data[0]?.usage.costCNY).toBeUndefined();

        const [facts] = await conn.query<(RowDataPacket & {
          usage_id: string;
          tenant_id: string;
          cost_cny: string | null;
          fact_sha256: string;
        })[]>(
          `SELECT usage_id, tenant_id, cost_cny, fact_sha256
             FROM billing_usage_facts
            WHERE usage_id IN (?,?) ORDER BY usage_id`,
          [unknownId, zeroId],
        );
        expect(facts).toHaveLength(2);
        expect(facts.find((row) => row.usage_id === unknownId)?.cost_cny).toBeNull();
        expect(Number(facts.find((row) => row.usage_id === zeroId)?.cost_cny)).toBe(0);
        expect(facts.every((row) => row.tenant_id === unknown.tenantId && /^[0-9a-f]{64}$/.test(row.fact_sha256))).toBe(true);

        const [columns] = await conn.query<(RowDataPacket & { column_name: string })[]>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema=DATABASE() AND table_name='billing_usage_facts'`,
        );
        const names = new Set(columns.map((row) => row.column_name));
        for (const forbidden of ["user_id", "session_id", "turn_id", "step", "usage_json", "created_at_ms"]) {
          expect(names.has(forbidden)).toBe(false);
        }
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("stores the checksummed high-magnitude billing amount in its canonical DECIMAL form across reconciliation retries", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = await createSession(store, conn);
      const usageId = newUsageId();
      const turnId = newId("turn");
      const highCost = 999_999_999_999_999.8;
      const canonicalCost = canonicalBillingCostCNY(highCost);
      const measured = usage({ costCNY: highCost });
      const expectedFact = billingUsageFactFromLedger({
        usageId,
        tenantId: session.tenantId,
        userId: session.userId,
        sessionId: session.id,
        turnId,
        step: 1,
        provider: "provider-high-value",
        model: "model-high-value",
        usage: measured,
        createdAtMs: MONTH_START,
      });
      try {
        // This value exposes the Number/String boundary: String(highCost) ends in `.8`, while the
        // checksum's deliberate 9-decimal normalization represents the actual double as `.750...`.
        expect(canonicalCost).toBe("999999999999999.750000000");
        await store.commit({
          sessionId: session.id,
          fence: 1,
          usageEntries: [{
            usageId,
            turnId,
            step: 1,
            provider: expectedFact.provider,
            model: expectedFact.model,
            usage: measured,
            createdAtMs: MONTH_START,
          }],
        });

        const [factRows] = await conn.query<(RowDataPacket & {
          cost_cny: string;
          fact_sha256: string;
        })[]>(
          "SELECT cost_cny, fact_sha256 FROM billing_usage_facts WHERE usage_id=?",
          [usageId],
        );
        expect(factRows).toEqual([expect.objectContaining({
          cost_cny: canonicalCost,
          fact_sha256: expectedFact.factSha256,
        })]);

        await tombstone(store, session);
        const input = {
          tenantId: session.tenantId,
          userId: session.userId,
          sessionId: session.id,
          deletionGeneration: 1,
          nowMs: MONTH_START + 200,
        };
        const verified = await store.reconcileSessionUsage(input);
        expect(canonicalBillingCostCNY(verified.costCNY!)).toBe(canonicalCost);
        const retry = await store.reconcileSessionUsage({ ...input, nowMs: MONTH_START + 300 });
        expect(retry).toEqual(verified);

        const [reconciliationRows] = await conn.query<(RowDataPacket & {
          cost_cny: string;
          checksum: string;
          verified_at_ms: number;
        })[]>(
          `SELECT cost_cny, checksum, verified_at_ms
             FROM usage_reconciliations
            WHERE session_id=? AND deletion_generation=1`,
          [session.id],
        );
        expect(reconciliationRows).toEqual([expect.objectContaining({
          cost_cny: canonicalCost,
          checksum: verified.checksum,
          verified_at_ms: input.nowMs,
        })]);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("normalizes historical null cost through query, reconciliation, and anonymization", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = await createSession(store, conn);
      try {
        await insertLegacyUsage(conn, session, {
          usage: {
            ...usage(),
            inputTokens: 5,
            outputTokens: 2,
            totalTokens: 7,
            costCNY: null,
          } as unknown as Usage,
        });
        expect((await store.queryUsage(session.tenantId, {
          sessionId: session.id, groupBy: "total", limit: 10,
        })).data[0]?.usage.costCNY).toBeUndefined();

        await tombstone(store, session);
        const verified = await store.reconcileSessionUsage({
          tenantId: session.tenantId,
          userId: session.userId,
          sessionId: session.id,
          deletionGeneration: 1,
          nowMs: MONTH_START + 200,
        });
        expect(verified).toMatchObject({ rowCount: 1, knownCostRows: 0, totalTokens: 7 });
        expect(verified).not.toHaveProperty("costCNY");

        const [facts] = await conn.query<(RowDataPacket & {
          usage_id: string;
          cost_cny: string | null;
        })[]>(
          `SELECT usage_id, cost_cny FROM billing_usage_facts
            WHERE usage_id=(SELECT usage_id FROM usage_ledger WHERE session_id=?)`,
          [session.id],
        );
        expect(facts).toHaveLength(1);
        expect(isUsageId(facts[0]?.usage_id)).toBe(true);
        expect(facts[0]?.cost_cny).toBeNull();

        await expect(store.anonymizeSessionUsage({
          tenantId: session.tenantId,
          userId: session.userId,
          sessionId: session.id,
          deletionGeneration: 1,
          expectedChecksum: verified.checksum,
          nowMs: MONTH_START + 300,
          enabled: true,
        })).resolves.toMatchObject({ status: "anonymized" });
        const [operational] = await conn.query<(RowDataPacket & { count: number })[]>(
          "SELECT COUNT(*) AS count FROM usage_ledger WHERE session_id=?",
          [session.id],
        );
        expect(Number(operational[0]?.count)).toBe(0);
        const [retained] = await conn.query<(RowDataPacket & { count: number })[]>(
          "SELECT COUNT(*) AS count FROM billing_usage_facts WHERE usage_id=?",
          [facts[0]?.usage_id],
        );
        expect(Number(retained[0]?.count)).toBe(1);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls back the complete commit when the billing identity already conflicts", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = await createSession(store, conn);
      const usageId = newUsageId();
      const conflicting = billingUsageFactFromLedger({
        usageId,
        tenantId: session.tenantId,
        userId: "not-retained",
        sessionId: "not-retained",
        turnId: "not-retained",
        step: 99,
        provider: "provider-a",
        model: "conflicting-model",
        usage: usage(),
        createdAtMs: MONTH_START,
      });
      try {
        await insertBillingFact(conn, conflicting);
        await expect(store.commit({
          sessionId: session.id,
          fence: 1,
          events: [{ type: "session/created", sessionId: session.id, emittedAtMs: MONTH_START + 2 }],
          usageEntries: [{
            usageId,
            turnId: newId("turn"),
            step: 1,
            provider: "provider-a",
            model: "model-a",
            usage: usage(),
            createdAtMs: MONTH_START,
          }],
          sessionPatch: { title: "must roll back" },
        })).rejects.toBeInstanceOf(UsageIdentityConflictError);

        expect(await store.getSession(session.tenantId, session.id)).toMatchObject({
          title: undefined,
          lastSeq: 1,
          fenceToken: 0,
        });
        expect(await store.readEvents(session.id, 0, 10)).toHaveLength(1);
        const [operational] = await conn.query<(RowDataPacket & { count: number })[]>(
          "SELECT COUNT(*) AS count FROM usage_ledger WHERE session_id=?",
          [session.id],
        );
        expect(Number(operational[0]?.count)).toBe(0);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("fails closed on operational usage whose owner differs from its session", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const corruptTenantId = `tenant_corrupt_${randomUUID()}`;
      const corruptUserId = `user_corrupt_${randomUUID()}`;
      const reconcileTarget = await createSession(store, conn);
      try {
        await insertLegacyUsage(conn, reconcileTarget, { usage: usage({ costCNY: 0.25 }) });
        await insertLegacyUsage(conn, reconcileTarget, {
          tenantId: corruptTenantId,
          userId: corruptUserId,
          step: 2,
        });
        await insertLegacyUsage(conn, reconcileTarget, {
          userId: corruptUserId,
          step: 3,
        });

        const projected = await store.getSession(reconcileTarget.tenantId, reconcileTarget.id);
        expect(projected?.usage).toMatchObject({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
        expect(projected?.usage).not.toHaveProperty("costCNY");
        const listed = await store.listSessions(reconcileTarget.tenantId, {
          userId: reconcileTarget.userId,
          includeArchived: true,
          limit: 10,
        });
        expect(listed.data.find((session) => session.id === reconcileTarget.id)?.usage)
          .not.toHaveProperty("costCNY");

        // The historical schema has no composite owner FK. Query joins must still prevent a
        // forged ledger owner from exposing another tenant's session usage.
        expect((await store.queryUsage(corruptTenantId, {
          sessionId: reconcileTarget.id,
          groupBy: "total",
          limit: 10,
        })).data).toEqual([]);
        expect((await store.queryUsage(reconcileTarget.tenantId, {
          userId: corruptUserId,
          sessionId: reconcileTarget.id,
          groupBy: "total",
          limit: 10,
        })).data).toEqual([]);

        await tombstone(store, reconcileTarget);
        await expect(store.reconcileSessionUsage({
          tenantId: reconcileTarget.tenantId,
          userId: reconcileTarget.userId,
          sessionId: reconcileTarget.id,
          deletionGeneration: 1,
          nowMs: MONTH_START + 200,
        })).rejects.toBeInstanceOf(UsageReconciliationError);
        const [unassigned] = await conn.query<(RowDataPacket & { usage_id: string | null })[]>(
          "SELECT usage_id FROM usage_ledger WHERE session_id=? ORDER BY id",
          [reconcileTarget.id],
        );
        expect(unassigned.map((row) => row.usage_id)).toEqual([null, null, null]);
        const [rollbackCounts] = await conn.query<(RowDataPacket & { facts: number; reconciliations: number })[]>(
          `SELECT
             (SELECT COUNT(*) FROM billing_usage_facts WHERE tenant_id=?) AS facts,
             (SELECT COUNT(*) FROM usage_reconciliations WHERE session_id=?) AS reconciliations`,
          [reconcileTarget.tenantId, reconcileTarget.id],
        );
        expect({
          facts: Number(rollbackCounts[0]?.facts),
          reconciliations: Number(rollbackCounts[0]?.reconciliations),
        }).toEqual({ facts: 0, reconciliations: 0 });

        const anonymizeTarget = await createSession(store, conn);
        await insertLegacyUsage(conn, anonymizeTarget);
        await tombstone(store, anonymizeTarget);
        const lifecycleInput = {
          tenantId: anonymizeTarget.tenantId,
          userId: anonymizeTarget.userId,
          sessionId: anonymizeTarget.id,
          deletionGeneration: 1,
          nowMs: MONTH_START + 300,
        };
        const verified = await store.reconcileSessionUsage(lifecycleInput);
        await insertLegacyUsage(conn, anonymizeTarget, {
          tenantId: corruptTenantId,
          userId: corruptUserId,
          step: 2,
        });

        await expect(store.anonymizeSessionUsage({
          ...lifecycleInput,
          expectedChecksum: verified.checksum,
          nowMs: MONTH_START + 400,
          enabled: true,
        })).rejects.toBeInstanceOf(UsageReconciliationError);
        const [preserved] = await conn.query<(RowDataPacket & { count: number })[]>(
          "SELECT COUNT(*) AS count FROM usage_ledger WHERE session_id=?",
          [anonymizeTarget.id],
        );
        expect(Number(preserved[0]?.count)).toBe(2);
        const [reconciliation] = await conn.query<(RowDataPacket & { status: string })[]>(
          "SELECT status FROM usage_reconciliations WHERE session_id=? AND deletion_generation=1",
          [anonymizeTarget.id],
        );
        expect(reconciliation).toEqual([expect.objectContaining({ status: "verified" })]);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("serializes concurrent legacy reconciliation and rejects owner or generation probes", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = await createSession(store, conn);
      try {
        await insertLegacyUsage(conn, session, { usage: usage() });
        await insertLegacyUsage(conn, session, { step: 2, usage: usage({ inputTokens: 4, totalTokens: 5, costCNY: 0 }) });
        await tombstone(store, session);
        const input = {
          tenantId: session.tenantId,
          userId: session.userId,
          sessionId: session.id,
          deletionGeneration: 1,
          nowMs: MONTH_START + 200,
        };
        const [left, right] = await Promise.all([
          store.reconcileSessionUsage(input),
          store.reconcileSessionUsage(input),
        ]);
        expect(left).toEqual(right);
        expect(left).toMatchObject({
          status: "verified",
          rowCount: 2,
          inputTokens: 6,
          totalTokens: 8,
          knownCostRows: 0,
        });
        expect(left).not.toHaveProperty("costCNY");
        const [rows] = await conn.query<(RowDataPacket & { usage_id: string | null; cost: string | null })[]>(
          `SELECT usage_id, JSON_UNQUOTE(JSON_EXTRACT(usage_json, '$.costCNY')) AS cost
             FROM usage_ledger WHERE session_id=? ORDER BY id`,
          [session.id],
        );
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => isUsageId(row.usage_id))).toBe(true);
        expect(rows.every((row) => row.cost == null)).toBe(true);
        expect(new Set(rows.map((row) => row.usage_id)).size).toBe(2);
        const [facts] = await conn.query<(RowDataPacket & { count: number })[]>(
          "SELECT COUNT(*) AS count FROM billing_usage_facts WHERE usage_id IN (?,?)",
          [rows[0]?.usage_id, rows[1]?.usage_id],
        );
        expect(Number(facts[0]?.count)).toBe(2);

        await expect(store.reconcileSessionUsage({ ...input, deletionGeneration: 0 }))
          .rejects.toBeInstanceOf(UsageLifecycleGenerationError);
        await expect(store.reconcileSessionUsage({ ...input, deletionGeneration: 2 }))
          .rejects.toBeInstanceOf(UsageLifecycleGenerationError);
        await expect(store.reconcileSessionUsage({ ...input, tenantId: `${session.tenantId}_other` }))
          .rejects.toBeInstanceOf(SessionGoneError);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls back legacy ids and reconciliation when an existing fact has conflicting content", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = await createSession(store, conn);
      const conflictingId = newUsageId();
      try {
        await insertLegacyUsage(conn, session, { usageId: conflictingId, model: "operational-model" });
        await insertLegacyUsage(conn, session, { step: 2, usage: usage({ costCNY: 0 }) });
        const conflicting = billingUsageFactFromLedger({
          usageId: conflictingId,
          tenantId: session.tenantId,
          userId: session.userId,
          sessionId: session.id,
          turnId: newId("turn"),
          step: 1,
          provider: "legacy-provider",
          model: "different-model",
          usage: usage(),
          createdAtMs: MONTH_START,
        });
        await insertBillingFact(conn, conflicting);
        await tombstone(store, session);

        await expect(store.reconcileSessionUsage({
          tenantId: session.tenantId,
          userId: session.userId,
          sessionId: session.id,
          deletionGeneration: 1,
          nowMs: MONTH_START + 200,
        })).rejects.toBeInstanceOf(UsageIdentityConflictError);
        const [rows] = await conn.query<(RowDataPacket & { usage_id: string | null; cost: string | null })[]>(
          `SELECT usage_id, JSON_UNQUOTE(JSON_EXTRACT(usage_json, '$.costCNY')) AS cost
             FROM usage_ledger WHERE session_id=? ORDER BY id`,
          [session.id],
        );
        expect(rows.map((row) => row.usage_id)).toEqual([conflictingId, null]);
        expect(Number(rows[1]?.cost)).toBe(0);
        const [reconciliations] = await conn.query<(RowDataPacket & { count: number })[]>(
          "SELECT COUNT(*) AS count FROM usage_reconciliations WHERE session_id=?",
          [session.id],
        );
        expect(Number(reconciliations[0]?.count)).toBe(0);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("re-verifies under locks, obeys durable legal hold, anonymizes idempotently, and retains facts", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const target = await createSession(store, conn);
      const other = await createSession(store, conn, target.tenantId, `${target.userId}_other`);
      try {
        await insertLegacyUsage(conn, target, { usage: usage({ costCNY: 0.25 }) });
        await insertLegacyUsage(conn, other, { usage: usage({ totalTokens: 9 }) });
        await tombstone(store, target);
        const lifecycleInput = {
          tenantId: target.tenantId,
          userId: target.userId,
          sessionId: target.id,
          deletionGeneration: 1,
          nowMs: MONTH_START + 200,
        };
        const verified = await store.reconcileSessionUsage(lifecycleInput);
        const [targetUsageRows] = await conn.query<(RowDataPacket & { usage_id: string })[]>(
          "SELECT usage_id FROM usage_ledger WHERE session_id=?",
          [target.id],
        );
        const targetUsageId = targetUsageRows[0]?.usage_id;
        expect(isUsageId(targetUsageId)).toBe(true);

        await expect(store.anonymizeSessionUsage({
          ...lifecycleInput,
          nowMs: MONTH_START + 300,
          expectedChecksum: verified.checksum,
          enabled: false,
        } as unknown as Parameters<MysqlSessionStore["anonymizeSessionUsage"]>[0]))
          .rejects.toBeInstanceOf(UsageAnonymizationDisabledError);
        await expect(store.anonymizeSessionUsage({
          ...lifecycleInput,
          nowMs: MONTH_START + 300,
          expectedChecksum: "0".repeat(64),
          enabled: true,
        })).rejects.toBeInstanceOf(UsageReconciliationError);

        const firstHoldId = newLegalHoldId();
        await store.setLegalHold({
          tenantId: target.tenantId,
          holdId: firstHoldId,
          subjectKind: "user",
          subjectId: target.userId,
          reasonCode: "billing_dispute",
          expectedControlGeneration: 0,
          actorKeyId: "usage-test",
          atMs: MONTH_START + 250,
        });
        await expect(store.anonymizeSessionUsage({
          ...lifecycleInput,
          nowMs: MONTH_START + 300,
          expectedChecksum: verified.checksum,
          enabled: true,
        })).rejects.toBeInstanceOf(UsageLegalHoldError);
        await store.releaseLegalHold({
          tenantId: target.tenantId,
          holdId: firstHoldId,
          expectedControlGeneration: 1,
          reasonCode: "matter_closed",
          actorKeyId: "usage-test",
          atMs: MONTH_START + 275,
        });

        const anonymized = await store.anonymizeSessionUsage({
          ...lifecycleInput,
          nowMs: MONTH_START + 300,
          expectedChecksum: verified.checksum,
          enabled: true,
        });
        expect(anonymized).toMatchObject({ status: "anonymized", anonymizedAtMs: MONTH_START + 300 });
        await store.setLegalHold({
          tenantId: target.tenantId,
          holdId: newLegalHoldId(),
          subjectKind: "user",
          subjectId: target.userId,
          reasonCode: "litigation",
          expectedControlGeneration: 2,
          actorKeyId: "usage-test",
          atMs: MONTH_START + 350,
        });
        const replay = await store.anonymizeSessionUsage({
          ...lifecycleInput,
          nowMs: MONTH_START + 400,
          expectedChecksum: verified.checksum,
          enabled: true,
        });
        // The first transaction may have committed even if its response was lost. A hold installed
        // afterward cannot undo that deletion, so the same-checksum retry must remain idempotent.
        expect(replay).toEqual(anonymized);

        const [operational] = await conn.query<(RowDataPacket & { session_id: string; count: number })[]>(
          `SELECT session_id, COUNT(*) AS count FROM usage_ledger
            WHERE session_id IN (?,?) GROUP BY session_id ORDER BY session_id`,
          [target.id, other.id],
        );
        expect(operational).toEqual([expect.objectContaining({ session_id: other.id, count: 1 })]);
        const [facts] = await conn.query<(RowDataPacket & { count: number })[]>(
          "SELECT COUNT(*) AS count FROM billing_usage_facts WHERE usage_id=?",
          [targetUsageId],
        );
        expect(Number(facts[0]?.count)).toBe(1);
      } finally {
        await conn.end();
        await store.close();
      }
    });
  });
} else {
  describe("MysqlSessionStore usage billing lifecycle", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
