import { randomUUID } from "node:crypto";
import mysql, { type Connection, type Pool, type RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OrdinarySessionUsageRetentionWorker } from "@agent-service/core";
import { MysqlSessionStore, newUsageId } from "@agent-service/store";
import { DEFAULT_AUTH_POLICY, emptyUsage, ORDINARY_SESSION_USAGE_RETENTION_LOCAL_V1, PROTOCOL_VERSION } from "@agent-service/protocol";
import { mkSession, newId } from "../../../packages/store/test/conformance.js";
import { createRouterApp } from "../../agent-router/src/app.js";
import { RunnerRegistry } from "../../agent-router/src/registry.js";
import { RouterOrdinarySessionUsageRetentionGate } from "../src/ordinary-session-usage-retention-gate.js";

const DAY = 86_400_000;
const TOKEN = "ordinary-usage-worker-mysql-private-token-0001";
const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) throw new Error("MYSQL_TEST_URL must target local disposable MySQL");
  return url;
}
function databaseUrl(base: URL, database: string): string {
  const url = new URL(base); url.pathname = `/${database}`; return url.toString();
}

/** Historical fixtures use MySQL's real per-connection clock, never edit a sealed floor. */
function bindDatabaseClock(store: MysqlSessionStore, now: () => number): void {
  const pool = (store as unknown as { pool: Pool }).pool;
  const checkout = pool.getConnection.bind(pool);
  pool.getConnection = async () => {
    const connection = await checkout();
    try { await connection.query("SET timestamp=?", [now() / 1_000]); return connection; }
    catch (error) { connection.release(); throw error; }
  };
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("runner ordinary session usage retention on real MySQL", () => {
    let admin: Connection | undefined;
    let mysqlUrl: string;
    let database = "";
    let created = false;
    let base: URL;
    beforeAll(async () => {
      base = disposableBase(BASE_MYSQL_URL);
      admin = await mysql.createConnection(databaseUrl(base, "mysql"));
    });
    beforeEach(async () => {
      database = `agent_service_usage_worker_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      const [existing] = await admin!.query<RowDataPacket[]>(
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database]);
      if (existing.length) throw new Error("disposable usage worker fixture database already exists");
      await admin!.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      created = true;
      mysqlUrl = databaseUrl(base, database);
      const migrated = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      await migrated.close();
    });
    afterEach(async () => {
      vi.unstubAllGlobals();
      if (created) await admin!.query(`DROP DATABASE IF EXISTS \`${database}\``);
      created = false;
    });
    afterAll(async () => { await admin?.end(); });

    async function fixture() {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 3 });
      const conn = await mysql.createConnection(mysqlUrl);
      let clock = Date.now() - 40 * DAY;
      bindDatabaseClock(store, () => clock);
      const session = { ...mkSession(`tenant-usage-worker-${randomUUID()}`, `user-usage-worker-${randomUUID()}`),
        createdAtMs: clock, updatedAtMs: clock };
      await store.setTenantAuth(session.tenantId, DEFAULT_AUTH_POLICY);
      await store.putRetentionPolicy({ tenantId: session.tenantId, policyVersion: "worker-policy-v1",
        actorKeyId: "worker-policy-admin", atMs: clock, policy: {
          sessionContentRetentionMs: 30 * DAY, userErasureGraceMs: 30 * DAY,
          operationalUsageRetentionMs: 30 * DAY, idempotencyReceiptRetentionMs: null,
          billingFactRetentionMs: null, lifecycleAuditRetentionMs: null, exportArtifactTtlMs: DAY,
        } });
      await store.activateRetentionPolicy({ tenantId: session.tenantId, policyVersion: "worker-policy-v1",
        expectedControlGeneration: 0, actorKeyId: "worker-policy-admin", atMs: clock });
      await store.createSession(session);
      const usageId = newUsageId();
      await store.commit({ sessionId: session.id, fence: 1, usageEntries: [{ usageId, turnId: newId("turn"), step: 1,
        provider: "fixture-provider", model: "fixture-model", usage: { ...emptyUsage(), inputTokens: 3, totalTokens: 3 }, createdAtMs: clock }] });
      await store.commitOrdinarySessionDelete({ sessionId: session.id, fence: 2,
        lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: session.userId,
          atMs: clock, purgeAfterMs: null, deletionGeneration: 1 },
        events: [{ type: "session/deleted", sessionId: session.id, emittedAtMs: clock, deletionGeneration: 1 }] });
      await store.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id);
      clock = Date.now() + DAY; // Due DB authority stays ahead of the audit clock even on a slow CI host.
      let routerEnabled = true;
      let runnersActive = true;
      let probes = 0;
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => {
        if (String(input).endsWith("/readyz")) { probes++; return new Response(null, { status: 200 }); }
        return Response.json({ protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: {
          streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true,
          sessionLifecycle: ["archive", "unarchive", "tombstone"],
          ordinarySessionUsageRetention: [ORDINARY_SESSION_USAGE_RETENTION_LOCAL_V1],
          ordinarySessionUsageRetentionWorker: runnersActive,
          dynamicTools: true, mcp: [], skills: false, sandbox: ["none"], byok: true,
        } });
      }));
      const registry = new RunnerRegistry({ runners: ["http://worker-a", "http://worker-b"] });
      const app = createRouterApp({ registry, internalRunnerToken: TOKEN,
        ordinarySessionUsageRetentionEnabled: () => routerEnabled, logger: { info() {}, warn() {}, error() {} } });
      const gate = new RouterOrdinarySessionUsageRetentionGate({ routerBaseUrl: "http://router",
        internalToken: TOKEN, requestTimeoutMs: 2_000,
        fetchImpl: async (input, init) => app.request(String(input), init) });
      const owner = { tenantId: session.tenantId, userId: session.userId, sessionId: session.id, deletionGeneration: 1 };
      return { store, conn, session, usageId, owner, gate, probes: () => probes, now: () => clock,
        router: (enabled: boolean) => { routerEnabled = enabled; }, runners: (active: boolean) => { runnersActive = active; },
        async close() { await registry.close(); vi.unstubAllGlobals(); await conn.end(); await store.close(); } };
    }

    async function state(f: Awaited<ReturnType<typeof fixture>>) {
      const [rows] = await f.conn.query<RowDataPacket[]>(
        `SELECT s.ordinary_usage_retention_receipt_json AS receipt,s.purge_after_ms,
          (SELECT COUNT(*) FROM usage_ledger u WHERE u.session_id=s.session_id) AS operational_count,
          (SELECT COUNT(*) FROM billing_usage_facts b WHERE b.usage_id=?) AS billing_count,
          (SELECT status FROM usage_reconciliations r WHERE r.session_id=s.session_id AND r.deletion_generation=1) AS reconciliation
          FROM sessions s WHERE s.session_id=?`, [f.usageId, f.session.id]);
      return rows[0]!;
    }

    it("blocks scanning at either closed gate then executes due usage only through the real store", async () => {
      const f = await fixture();
      const scan = vi.spyOn(f.store, "listOrdinarySessionUsageRetentionCandidates");
      const reconcile = vi.spyOn(f.store, "reconcileSessionUsage");
      const execute = vi.spyOn(f.store, "executeOrdinarySessionUsageRetention");
      const worker = new OrdinarySessionUsageRetentionWorker({ store: f.store, canExecute: () => f.gate.canExecute(), logger: { warn() {} } });
      try {
        f.router(false); expect(await worker.pollOnce()).toBe(0);
        f.router(true); f.runners(false); expect(await worker.pollOnce()).toBe(0);
        expect(scan).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
        f.runners(true);
        const probes = f.probes();
        const completed = await worker.pollOnce();
        expect(reconcile).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce();
        await expect(execute.mock.results[0]!.value).resolves.not.toBeNull();
        expect(completed).toBe(1);
        expect(f.probes() - probes).toBe(6); // Two configured runners freshly checked at all three boundaries.
        const after = await state(f);
        expect(Number(after.operational_count)).toBe(0); expect(Number(after.billing_count)).toBe(1);
        expect(after.reconciliation).toBe("anonymized"); expect(after.purge_after_ms).toBeNull();
        expect(after.receipt).toMatchObject({ allDomainsComplete: false, contentPurgeExecuted: false });
        expect((await f.store.readEvents(f.session.id, 0, 10)).map((event) => event.type)).toEqual(["session/created", "session/deleted"]);
        expect((await f.store.getLifecycleOutbox("session.purge", f.session.id, 1))?.availableAtMs).toBeUndefined();
        f.router(false); // Exact committed receipt remains readable without a new fleet grant.
        expect(await f.store.executeOrdinarySessionUsageRetention(execute.mock.calls[0]![0])).toEqual(after.receipt);
      } finally { await worker.stop(); await f.close(); }
    });

    it("rechecks a canonical hold inserted after real reconciliation and deletes nothing", async () => {
      const f = await fixture();
      let boundary = 0;
      const worker = new OrdinarySessionUsageRetentionWorker({ store: f.store, logger: { warn() {} }, canExecute: async () => {
        const ready = await f.gate.canExecute();
        if (++boundary === 3) await f.store.setLegalHold({ tenantId: f.session.tenantId, subjectKind: "user",
          subjectId: f.session.userId, holdId: `hold_${randomUUID()}`, reasonCode: "litigation",
          expectedControlGeneration: 0, actorKeyId: "worker-policy-admin", atMs: f.now() });
        return ready;
      } });
      try {
        expect(await worker.pollOnce()).toBe(0);
        expect(boundary).toBe(3);
        const after = await state(f);
        expect(Number(after.operational_count)).toBe(1); expect(Number(after.billing_count)).toBe(1);
        expect(after.reconciliation).toBe("verified"); expect(after.receipt).toBeNull();
      } finally { await worker.stop(); await f.close(); }
    });

    it("fails closed when the operational source drifts after real reconciliation", async () => {
      const f = await fixture();
      const warn = vi.fn();
      let boundary = 0;
      const worker = new OrdinarySessionUsageRetentionWorker({ store: f.store, logger: { warn }, canExecute: async () => {
        const ready = await f.gate.canExecute();
        if (++boundary === 3) await f.conn.query("UPDATE usage_ledger SET model='drifted-model' WHERE session_id=?", [f.session.id]);
        return ready;
      } });
      try {
        expect(await worker.pollOnce()).toBe(0);
        expect(boundary).toBe(3);
        const after = await state(f);
        expect(Number(after.operational_count)).toBe(1); expect(Number(after.billing_count)).toBe(1);
        expect(after.reconciliation).toBe("verified"); expect(after.receipt).toBeNull();
        expect(warn.mock.calls).toEqual([["ordinary session usage retention failed"]]);
      } finally { await worker.stop(); await f.close(); }
    });
  });
} else {
  describe("runner ordinary session usage retention on real MySQL", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 to exercise real InnoDB", () => {});
  });
}
