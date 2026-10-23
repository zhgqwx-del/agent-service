import { randomUUID } from "node:crypto";
import { createConnection as createSocket, type Socket } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../test/fixtures/mysql-runtime.mjs";
import { createMysqlAuthorityCliExecutor } from "../../../test/fixtures/mysql-authority-cli.mjs";
import { withFixtureSessionAuthority } from "../../store/test/fixtures/session-authority.js";
import { emptyUsage, type Session } from "@agent-service/protocol";
import {
  MysqlSessionStore,
  billingUsageFactFromLedger,
  newErasureRequestId,
  newUsageId,
  userErasureRequestHash,
  type ErasureJobAuthorization,
  type ErasureJobClaim,
  type ErasureSessionCatalogStore,
  type UsageLedgerEntry,
} from "@agent-service/store";

const allowClaims = async () => true;
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ErasureWorker, newId, type ErasureSessionExecutor } from "../src/index.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create erasure worker fixture database from base database "${database}": `
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

const executor: ErasureSessionExecutor = {
  async drainSessionForErasure() {},
  async eraseSessionForErasure() {},
};

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("ErasureWorker MySQL tombstone proof gate", () => {
    let admin: Connection | undefined;
    let conn: Connection | undefined;
    let store: MysqlSessionStore | undefined;
    let database = "";
    let operatorUrl = "";
    let runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined;
    const preparation = new AbortController();
    const factories = new Set<Promise<unknown>>();
    const stores = new Set<MysqlSessionStore>();
    const connections = new Set<Connection>();
    const sockets = new Map<Socket, Promise<void>>();
    const connectionSockets = new Map<Connection, Socket>();
    const connectionCloses = new Map<Connection, Promise<void>>();
    let preparing: Promise<void> | undefined;
    let prepared = false, closing = false, createAttempted = false;
    let passedCases = 0, failedCase = false;
    let closeFailure: { reason: unknown } | undefined;
    const remember = (reason: unknown) => { closeFailure ??= { reason }; };
    const active = () => {
      preparation.signal.throwIfAborted();
      if (closing) throw new Error("erasure worker fixture is closing");
    };
    const ownFactory = <T,>(raw: Promise<T>): Promise<T> => {
      factories.add(raw);
      void raw.then(() => factories.delete(raw), () => factories.delete(raw));
      return raw;
    };
    const connectSql = (url: string): Promise<Connection> => {
      active();
      let socket: Socket | undefined;
      const raw = mysql.createConnection({ uri: url,
        stream: ({ config }: { config: { host: string; port: number } }) => {
          if (socket) throw new Error("erasure worker fixture socket already exists");
          socket = createSocket({ host: config.host, port: config.port });
          sockets.set(socket, new Promise<void>(resolve => socket!.once("close", () => resolve())));
          if (closing || preparation.signal.aborted) queueMicrotask(() => socket?.destroy());
          return socket;
        },
      });
      ownFactory(raw);
      void raw.then(value => {
        connections.add(value);
        if (socket) connectionSockets.set(value, socket);
      }, () => {});
      return raw;
    };
    const closeSql = (value: Connection): Promise<void> => {
      const prior = connectionCloses.get(value);
      if (prior) return prior;
      const work = (async () => {
        let first: { reason: unknown } | undefined;
        try { if (!preparation.signal.aborted) await value.end(); }
        catch (reason) { first = { reason }; }
        finally {
          try { value.destroy(); } catch (reason) { first ??= { reason }; }
          const socket = connectionSockets.get(value);
          if (socket) {
            try { socket.destroy(); } catch (reason) { first ??= { reason }; }
            await sockets.get(socket);
          }
        }
        if (first) throw first.reason;
      })();
      connectionCloses.set(value, work);
      return work;
    };
    const stop = () => {
      for (const value of connections) try { value.destroy(); } catch (reason) { remember(reason); }
      for (const socket of sockets.keys()) try { socket.destroy(); } catch (reason) { remember(reason); }
    };
    preparation.signal.addEventListener("abort", stop, { once: true });

    beforeAll(async () => {
      preparing = (async () => {
        const base = assertDisposableTestTarget(BASE_MYSQL_URL);
        database = `agent_service_erasure_worker_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
        if (!/^agent_service_erasure_worker_test_[a-zA-Z0-9_]+$/.test(database)) {
          throw new Error("unsafe generated erasure worker fixture database name");
        }
        operatorUrl = databaseUrl(base, database);
        const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl, applicationDatabase: database,
          operationAbortSignal: preparation.signal });
        active();
        admin = await connectSql(databaseUrl(base, "mysql"));
        active(); createAttempted = true;
        await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
        active();
        const cwd = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
        const entrypoint = fileURLToPath(new URL("../../../apps/agent-runner/src/main.ts", import.meta.url));
        runtime = await prepareMysqlRuntimeFixture(witness, {
          schemaExecutor: operation => MysqlSessionStore.runSchemaOperation(operation),
          authorityExecutor: createMysqlAuthorityCliExecutor({ entrypoint, mode: "source", cwd }),
        });
        active();
        const raw = MysqlSessionStore.connect({ ...runtime.runtimeStoreOptions, connectionLimit: 8,
          operationAbortSignal: preparation.signal });
        ownFactory(raw); void raw.then(value => stores.add(value), () => {});
        store = await raw; active();
        conn = await connectSql(operatorUrl); active();
        prepared = true;
      })();
      await preparing;
    });

    afterEach(({ task }) => {
      if (task.result?.state === "pass") passedCases++;
      else failedCase = true;
    });

    afterAll(async () => {
      closing = true;
      if (!prepared || failedCase || passedCases !== 7) preparation.abort();
      // A failed/expired beforeAll still owns its original startup and late factory results.
      await preparing?.catch(() => {});
      while (factories.size) await Promise.allSettled([...factories]);
      const closed = await Promise.allSettled([
        ...[...stores].map(value => value.close()),
        ...[...connections].filter(value => value !== admin).map(closeSql),
      ]);
      for (const result of closed) if (result.status === "rejected") remember(result.reason);
      const successful = prepared && passedCases === 7 && !failedCase && !preparation.signal.aborted && !closeFailure;
      try {
        if (runtime) {
          if (successful) await runtime.assertReusable(operatorUrl);
          await runtime.close({ successful });
        }
        if (successful && !closeFailure && admin && runtime) {
          const [identity] = await admin.query<RowDataPacket[]>("SELECT @@server_uuid AS uuid,DATABASE() AS db");
          const [references] = await admin.query<RowDataPacket[]>(
            "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?", [database]);
          const [transactions] = await admin.query<RowDataPacket[]>(
            "SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?", [database]);
          if (identity.length !== 1 || identity[0]?.db !== "mysql"
            || String(identity[0]?.uuid).toLowerCase() !== runtime.serverUuid.toLowerCase()
            || Number(references[0]?.n) !== 0 || Number(transactions[0]?.n) !== 0
            || !/^agent_service_erasure_worker_test_[a-zA-Z0-9_]+$/.test(database)) {
            throw new Error("erasure worker fixture cleanup identity is not proven");
          }
          await admin.query(`DROP DATABASE \`${database}\``);
          const [remaining] = await admin.query<RowDataPacket[]>(
            "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [database]);
          if (remaining.length !== 0) throw new Error("erasure worker fixture database remains");
        } else if (createAttempted) {
          console.warn(JSON.stringify({ schema: "erasure-worker-mysql-fixture-retained-v1",
            applicationDatabase: database, status: "retained_or_unknown" }));
        }
      } catch (reason) { remember(reason); }
      finally {
        // Reuse the exact cached close; an assertion/close failure never turns retention into success.
        if (runtime) try { await runtime.close({ successful: false }); } catch (reason) { remember(reason); }
        if (admin) try { await closeSql(admin); } catch (reason) { remember(reason); }
        preparation.abort();
        for (const socket of sockets.keys()) try { socket.destroy(); } catch (reason) { remember(reason); }
        await Promise.all(sockets.values());
        preparation.signal.removeEventListener("abort", stop);
      }
      if (closeFailure) throw closeFailure.reason;
    });

    async function fixture(): Promise<{
      session: Session;
      requestId: string;
      nowMs: number;
    }> {
      if (!store) throw new Error("fixture store is unavailable");
      const nowMs = Date.now();
      const session: Session = {
        id: newId("sess"),
        tenantId: `tenant_worker_proof_${randomUUID()}`,
        userId: `user_${randomUUID()}`,
        agentId: newId("agt"),
        agentVersion: 1,
        status: { type: "idle" },
        lastSeq: 0,
        contextEpoch: "e0",
        fenceToken: 0,
        usage: emptyUsage(),
        autoApprovedTools: [],
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        metadata: {},
      };
      await store.createSession(session);
      await withFixtureSessionAuthority(store, session, 0, async writer => {
        await store!.commit(writer.admit({
          sessionId: session.id,
          fence: 1,
          lifecycle: {
            type: "tombstone",
            tenantId: session.tenantId,
            userId: session.userId,
            deletionGeneration: 1,
            atMs: nowMs + 1,
          },
          events: [{
            type: "session/deleted",
            sessionId: session.id,
            deletionGeneration: 1,
            emittedAtMs: nowMs + 1,
          }],
        }));
      });

      const requestId = newErasureRequestId();
      await store.requestUserErasure({
        requestId,
        tenantId: session.tenantId,
        userId: session.userId,
        requestedByKeyId: "mysql-proof",
        idempotencyKey: requestId,
        requestHash: userErasureRequestHash(session.tenantId, session.userId),
        atMs: nowMs + 2,
      });
      let current = (await store.claimErasureJobs({
        nowMs: nowMs + 2,
        limit: 100,
        leaseMs: 30_000,
        claimToken: `proof-gated-${randomUUID()}`,
      })).find((claim) => claim.requestId === requestId)!;
      for (const toStatus of ["draining", "tombstoning", "reconciling_usage"] as const) {
        expect(await store.transitionErasureJob(jobAuthorization(current), {
          fromStatus: current.status,
          toStatus,
          atMs: nowMs + 2,
          availableAtMs: nowMs + 2,
        })).toBe(true);
        current = (await store.claimErasureJobs({
          nowMs: nowMs + 2,
          limit: 100,
          leaseMs: 30_000,
          claimToken: `proof-${toStatus}-${randomUUID()}`,
        })).find((claim) => claim.requestId === requestId)!;
      }
      expect(await store.retryErasureJob(jobAuthorization(current), {
        failedAtMs: nowMs + 2,
        availableAtMs: nowMs + 2,
        errorCode: "temporary_failure",
      })).toBe(true);
      return { session, requestId, nowMs: nowMs + 2 };
    }

    it("accepts the complete durable proof and reaches awaiting_purge_policy", async () => {
      if (!store) throw new Error("fixture store is unavailable");
      const h = await fixture();
      expect(await store.claimLifecycleOutbox({
        topics: ["session.tombstoned"],
        nowMs: h.nowMs + 1,
        limit: 1,
        leaseMs: 10_000,
        claimToken: `proof-delivery-${randomUUID()}`,
      })).toHaveLength(1);
      const worker = new ErasureWorker({
        jobs: store,
        catalog: store,
        usage: store,
        executor,
        canClaim: allowClaims,
        clock: { now: () => h.nowMs + 1 },
      });

      await expect(worker.processOnce()).resolves.toBe(1);
      await expect(store.getUserErasureRequest(
        h.session.tenantId,
        h.session.userId,
        h.requestId,
      )).resolves.toMatchObject({ status: "awaiting_purge_policy" });
    });

    it("blocks proof damage between catalog enumeration and atomic usage reconciliation with no partial writes", async () => {
      if (!store || !conn) throw new Error("fixture database is unavailable");
      const h = await fixture();
      await conn.query(
        `INSERT INTO usage_ledger
           (usage_id, tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms)
         VALUES (NULL,?,?,?,?,1,'legacy','legacy',?,?)`,
        [
          h.session.tenantId,
          h.session.userId,
          h.session.id,
          newId("turn"),
          JSON.stringify({ ...emptyUsage(), inputTokens: 1, totalTokens: 1 }),
          h.nowMs,
        ],
      );
      let damaged = false;
      const catalog: ErasureSessionCatalogStore = {
        listErasureSessions: async (authority, query) => {
          const page = await store!.listErasureSessions(authority, query);
          if (query.phase === "reconciling_usage" && !damaged && page.data.length > 0) {
            await conn!.query(
              "UPDATE lifecycle_outbox SET attempts=1 WHERE aggregate_id=? AND topic='session.purge'",
              [h.session.id],
            );
            damaged = true;
          }
          return page;
        },
        inspectErasureSubjectProgress: (authority, query) => (
          store!.inspectErasureSubjectProgress(authority, query)
        ),
      };
      const worker = new ErasureWorker({
        jobs: store,
        catalog,
        usage: store,
        executor,
        canClaim: allowClaims,
        clock: { now: () => h.nowMs + 1 },
      });

      await expect(worker.processOnce()).resolves.toBe(1);
      await expect(store.getUserErasureRequest(
        h.session.tenantId,
        h.session.userId,
        h.requestId,
      )).resolves.toMatchObject({
        status: "blocked",
        lastErrorCode: "integrity_conflict",
      });
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT u.usage_id,
                (SELECT COUNT(*) FROM billing_usage_facts b WHERE b.tenant_id=?) AS billing_count,
                (SELECT COUNT(*) FROM usage_reconciliations r WHERE r.session_id=?) AS reconciliation_count
           FROM usage_ledger u WHERE u.session_id=?`,
        [h.session.tenantId, h.session.id, h.session.id],
      );
      expect(rows[0]?.usage_id).toBeNull();
      expect(Number(rows[0]?.billing_count)).toBe(0);
      expect(Number(rows[0]?.reconciliation_count)).toBe(0);
    });

    it("durably blocks a conflicting billing fact and rolls back every reconciliation write", async () => {
      if (!store || !conn) throw new Error("fixture database is unavailable");
      const h = await fixture();
      const [firstId, conflictId] = [newUsageId(), newUsageId()].sort() as [string, string];
      const usageEntry = (step: number, usageId?: string): UsageLedgerEntry => ({
        ...(usageId === undefined ? {} : { usageId }),
        tenantId: h.session.tenantId,
        userId: h.session.userId,
        sessionId: h.session.id,
        turnId: newId("turn"),
        step,
        provider: "legacy-provider",
        model: "legacy-model",
        usage: { ...emptyUsage(), inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        createdAtMs: Date.UTC(2026, 9, 1),
      });
      const first = usageEntry(1, firstId);
      const legacy = usageEntry(2);
      const conflict = usageEntry(3, conflictId);
      for (const entry of [first, legacy, conflict]) {
        await conn.query(
          `INSERT INTO usage_ledger
             (usage_id, tenant_id, user_id, session_id, turn_id, step, provider, model,
              usage_json, created_at_ms)
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
      const conflictingFact = billingUsageFactFromLedger({
        ...conflict,
        usageId: conflictId,
        model: "different-model",
      });
      await conn.query(
        `INSERT INTO billing_usage_facts
           (usage_id, tenant_id, accounting_period, provider, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, cost_cny,
            currency, fact_sha256)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          conflictingFact.usageId,
          conflictingFact.tenantId,
          conflictingFact.accountingPeriod,
          conflictingFact.provider,
          conflictingFact.model,
          conflictingFact.inputTokens,
          conflictingFact.outputTokens,
          conflictingFact.cacheReadTokens,
          conflictingFact.cacheWriteTokens,
          conflictingFact.reasoningTokens,
          conflictingFact.totalTokens,
          null,
          conflictingFact.currency,
          conflictingFact.factSha256,
        ],
      );
      const worker = new ErasureWorker({
        jobs: store,
        catalog: store,
        usage: store,
        executor,
        canClaim: allowClaims,
        clock: { now: () => h.nowMs + 1 },
      });

      await expect(worker.processOnce()).resolves.toBe(1);

      await expect(store.getUserErasureRequest(
        h.session.tenantId,
        h.session.userId,
        h.requestId,
      )).resolves.toMatchObject({
        status: "blocked",
        lastErrorCode: "integrity_conflict",
      });
      const [usageRows] = await conn.query<RowDataPacket[]>(
        "SELECT step, usage_id FROM usage_ledger WHERE session_id=? ORDER BY step",
        [h.session.id],
      );
      const [billingRows] = await conn.query<RowDataPacket[]>(
        "SELECT usage_id FROM billing_usage_facts WHERE tenant_id=? ORDER BY usage_id",
        [h.session.tenantId],
      );
      const [reconciliations] = await conn.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM usage_reconciliations WHERE session_id=?",
        [h.session.id],
      );
      expect(usageRows.map((row) => row.usage_id)).toEqual([firstId, null, conflictId]);
      expect(billingRows.map((row) => row.usage_id)).toEqual([conflictId]);
      expect(Number(reconciliations[0]?.n)).toBe(0);
    });

    it.each([
      ["marker", async (connection: Connection, sessionId: string) => {
        await connection.query("UPDATE sessions SET deleted_at_ms=deleted_at_ms+1 WHERE session_id=?", [sessionId]);
      }],
      ["terminal event", async (connection: Connection, sessionId: string) => {
        await connection.query(
          "UPDATE events SET body=JSON_SET(body, '$.deletionGeneration', 2) WHERE session_id=? AND type='session/deleted'",
          [sessionId],
        );
      }],
      ["session.tombstoned intent", async (connection: Connection, sessionId: string) => {
        await connection.query(
          "UPDATE lifecycle_outbox SET dead_lettered_at_ms=1 WHERE aggregate_id=? AND topic='session.tombstoned'",
          [sessionId],
        );
      }],
      ["session.purge intent", async (connection: Connection, sessionId: string) => {
        await connection.query(
          "UPDATE lifecycle_outbox SET attempts=1 WHERE aggregate_id=? AND topic='session.purge'",
          [sessionId],
        );
      }],
    ] as const)("durably blocks real-MySQL %s corruption before usage reconciliation", async (_name, corrupt) => {
      if (!store || !conn) throw new Error("fixture database is unavailable");
      const h = await fixture();
      await corrupt(conn, h.session.id);
      const worker = new ErasureWorker({
        jobs: store,
        catalog: store,
        usage: store,
        executor,
        canClaim: allowClaims,
        clock: { now: () => h.nowMs + 1 },
      });

      await expect(worker.processOnce()).resolves.toBe(1);
      await expect(store.getUserErasureRequest(
        h.session.tenantId,
        h.session.userId,
        h.requestId,
      )).resolves.toMatchObject({
        status: "blocked",
        lastErrorCode: "integrity_conflict",
      });
    });
  });
}
