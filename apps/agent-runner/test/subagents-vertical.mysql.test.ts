import { randomBytes } from "node:crypto";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { MysqlSessionStore, createSubagentRootAccess, attachSessionWriteAdmission } from "@agent-service/store";
import { runSubagentsVertical } from "./fixtures/subagents-vertical.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../test/fixtures/mysql-runtime.mjs";
import { createSourceAuthorityExecutor } from "./fixtures/mysql-authority.js";
import { acquireFixedFixtureAuthority } from "./fixtures/session-authority.js";

const OWNED = /^agent_service_subagents_test_[a-f0-9]{24}$/;
function baseUrl(): URL {
  try {
    const value = new URL(process.env.MYSQL_TEST_URL ?? ""), db = decodeURIComponent(value.pathname.slice(1));
    if (value.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(value.hostname) || !value.username
      || !/^[A-Za-z0-9_]+$/.test(db) || !/(?:^|_)test(?:$|_)/i.test(db) || value.search || value.hash) throw new Error();
    return value;
  } catch { throw new Error("Subagent vertical requires an explicit loopback MYSQL_TEST_URL test schema."); }
}
function urlFor(base: URL, database: string): string { const next = new URL(base); next.pathname = `/${database}`; return next.toString(); }
const suite = process.env.AGENT_SERVICE_INTEGRATION === "1" ? describe : describe.skip;

suite("root-bound subagents source-App/Pi with a fresh native MySQL database", () => {
  it("preserves the actual parent/child histories and unique billing facts across a verify-only cold store", async ({ signal, onTestFailed }) => {
    const base = baseUrl(), database = `agent_service_subagents_test_${randomBytes(12).toString("hex")}`;
    if (!OWNED.test(database) || database === decodeURIComponent(base.pathname.slice(1))) throw new Error("Subagent fixture ownership invalid.");
    const began = performance.now(), deadline = began + 44_000, adminUrl = urlFor(base, "mysql"), url = urlFor(base, database);
    let admin: Connection | undefined, store: MysqlSessionStore | undefined, cold: MysqlSessionStore | undefined;
    let runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined, runtimeReleased = false;
    let serverIdentity = "", createAttempted = false, created = false, dropped = false, passed = false, servicesClosed = false, uncertain = false, stage = "preflight";
    let primaryFailed = false, primaryError: unknown;
    type DiagnosticPhase = "preflight" | "fresh_apply_connect" | "source_app" | "hot_close"
      | "cold_verify" | "cold_reads" | "cold_close" | "billing" | "cleanup";
    let diagnosticPhase: DiagnosticPhase = "preflight";
    const snapshot = () => ({ phase: diagnosticPhase, elapsedMs: Math.max(0, Math.floor(performance.now() - began)) });
    let firstDiagnostic: ReturnType<typeof snapshot> | undefined;
    const freezeDiagnostic = () => { try { firstDiagnostic ??= snapshot(); } catch { /* Observation cannot affect the case. */ } };
    signal.addEventListener("abort", freezeDiagnostic, { once: true });
    if (signal.aborted) freezeDiagnostic();
    onTestFailed(() => {
      try {
        const observed = firstDiagnostic ?? snapshot();
        console.error(JSON.stringify({ schema: "mysql-case-phase-diagnostic-v1", caseLabel: "subagents_vertical_mysql", ...observed }));
      } catch { /* Never replace the original failure with a diagnostic failure. */ }
    });
    const check = () => { if (performance.now() >= deadline) throw new Error("Subagent fixture cleanup deadline exceeded."); };
    const endAdmin = async () => { if (admin) { uncertain = true; const connection = admin; await connection.end(); admin = undefined; uncertain = false; } };
    try {
      admin = await mysql.createConnection({ uri: adminUrl, connectTimeout: 5_000 });
      const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS identity,DATABASE() AS db", timeout: 5_000 });
      serverIdentity = String(identity[0]?.identity); expect(serverIdentity).toMatch(/^[a-f0-9-]{36}$/i); expect(identity[0]?.db).toBe("mysql");
      const [prior] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", timeout: 5_000 }, [database]);
      expect(prior).toHaveLength(0); check();
      const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: url, applicationDatabase: database,
        operationAbortSignal: signal });
      createAttempted = true;
      await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`, timeout: 5_000 }); created = true; await endAdmin();
      diagnosticPhase = "fresh_apply_connect";
      runtime = await prepareMysqlRuntimeFixture(witness, {
        schemaExecutor: options => MysqlSessionStore.runSchemaOperation(options),
        authorityExecutor: createSourceAuthorityExecutor(),
      });
      check(); await runtime.assertReusable(url); check();
      stage = "real_source_app"; store = await MysqlSessionStore.connect({ ...runtime.runtimeStoreOptions, connectionLimit: 4,
        operationAbortSignal: signal }); check();
      diagnosticPhase = "source_app";
      const result = await runSubagentsVertical({ store, profile: "source-app-mysql", onOwnedServicesClosed: () => { servicesClosed = true; } });
      diagnosticPhase = "hot_close";
      expect(servicesClosed).toBe(true); check(); await store.close(); store = undefined;
      diagnosticPhase = "cold_verify";
      stage = "cold_verify"; await runtime.assertReusable(url); check();
      cold = await MysqlSessionStore.connect({ ...runtime.runtimeStoreOptions, connectionLimit: 2,
        operationAbortSignal: signal }); check();
      diagnosticPhase = "cold_reads";
      const tasks = await cold.listSubagentTasks({ principal: result.owner, rootSessionId: result.rootSessionId, rootTurnId: result.rootTurnId });
      expect(tasks).toHaveLength(1); expect(tasks[0]).toMatchObject({ taskId: result.task.taskId, status: "completed", childSessionId: result.childSessionId });
      // P3 is a new, explicit protected observation owner after P2 was confirmed and released.
      // Its fixed predecessor comes only from that result, never from an opportunistically read floor.
      const observation = await acquireFixedFixtureAuthority(cold, { id: result.rootSessionId, ...result.owner },
        result.postTurnObservationFence, { label: "subagents-cold-observation", ttlMs: 10_000 });
      let family: Awaited<ReturnType<MysqlSessionStore["getSubagentRoot"]>>;
      try {
        const access = attachSessionWriteAdmission(createSubagentRootAccess({ principal: result.owner,
          rootSessionId: result.rootSessionId, rootTurnId: result.rootTurnId, rootFence: observation.fence }), observation.proof);
        family = await cold.getSubagentRoot({ access });
      } finally { await observation.release(); }
      expect(family).toMatchObject({ state: "terminal", steps: 5, toolCalls: 3, taskCount: 1, activeTasks: 0, familyUsage: { totalTokens: 60 } });
      for (const [sessionId, turnId, events, items] of [
        [result.rootSessionId, result.rootTurnId, result.parentEvents, result.parentItems],
        [result.childSessionId, result.childTurnId, result.childEvents, result.childItems],
      ] as const) {
        expect(await cold.getSession(result.owner.tenantId, sessionId)).toMatchObject({ userId: result.owner.userId, status: { type: "idle" }, lastSeq: events.at(-1)!.seq });
        expect(await cold.getTurn(sessionId, turnId)).toMatchObject({ status: "completed", stopReason: "end_turn" });
        const actualEvents = await cold.readEvents(sessionId, 0, 1000), actualItems = await cold.listItems(sessionId, { limit: 200 });
        // Money JSON may round one binary64 ULP; compare all source identity/payload items exactly,
        // and the complete durable event identity/order rather than normalizing arbitrary numbers.
        expect(actualItems).toEqual(items);
        expect(actualEvents.map(event => [event.seq, event.type, event.sessionId])).toEqual(events.map(event => [event.seq, event.type, event.sessionId]));
      }
      diagnosticPhase = "cold_close";
      await cold.close(); cold = undefined; check();
      diagnosticPhase = "billing";
      stage = "billing"; admin = await mysql.createConnection({ uri: adminUrl, connectTimeout: 5_000 });
      const [ledger] = await admin.query<RowDataPacket[]>({ sql: `SELECT usage_id,session_id,turn_id,step FROM \`${database}\`.usage_ledger WHERE BINARY tenant_id=BINARY ? ORDER BY session_id,step`, timeout: 5_000 }, [result.owner.tenantId]);
      const [facts] = await admin.query<RowDataPacket[]>({ sql: `SELECT usage_id,total_tokens FROM \`${database}\`.billing_usage_facts WHERE BINARY tenant_id=BINARY ? ORDER BY usage_id`, timeout: 5_000 }, [result.owner.tenantId]);
      expect(ledger).toHaveLength(5); expect(facts).toHaveLength(5); expect(new Set(ledger.map(row => String(row.usage_id))).size).toBe(5);
      expect(facts.map(row => String(row.usage_id)).sort()).toEqual(ledger.map(row => String(row.usage_id)).sort());
      expect(ledger.map(row => `${row.session_id}:${row.turn_id}:${row.step}`).sort()).toEqual([
        `${result.rootSessionId}:${result.rootTurnId}:1`, `${result.rootSessionId}:${result.rootTurnId}:2`,
        `${result.childSessionId}:${result.childTurnId}:1`, `${result.childSessionId}:${result.childTurnId}:2`, `${result.childSessionId}:${result.childTurnId}:3`,
      ].sort());
      expect(facts.reduce((sum, row) => sum + Number(row.total_tokens), 0)).toBe(60);
      check(); passed = true;
    } catch (error) {
      // The shared source-App fixture already emits a bounded stage/code/name/frame diagnostic.
      // Preserve it (and real assertion failures) rather than replacing it with this outer stage.
      freezeDiagnostic();
      primaryFailed = true; primaryError = error; throw error;
    }
    finally {
      diagnosticPhase = "cleanup";
      const cleanupErrors: Error[] = [];
      const close = async (part: string, work: () => Promise<void>) => {
        try { await work(); } catch { cleanupErrors.push(new Error(`Subagent fixture ${part} close unproved.`)); }
      };
      await close("cold store", async () => { if (cold) { await cold.close(); cold = undefined; } });
      await close("store", async () => { if (store) { await store.close(); store = undefined; } });
      await close("admin", endAdmin);
      if (runtime) {
        const successful = passed && servicesClosed && !uncertain && cleanupErrors.length === 0 && performance.now() < deadline;
        await close("runtime account/metadata", async () => { await runtime!.close({ successful }); runtimeReleased = successful; });
      }
      if (created && passed && servicesClosed && runtimeReleased && !uncertain && cleanupErrors.length === 0 && performance.now() < deadline) {
        try {
          admin = await mysql.createConnection({ uri: adminUrl, connectTimeout: 5_000 }); check();
          const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS identity,DATABASE() AS db", timeout: 5_000 });
          expect(identity[0]).toMatchObject({ identity: serverIdentity, db: "mysql" });
          const [connections] = await admin.query<RowDataPacket[]>({ sql: "SELECT ID FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND (BINARY DB=BINARY ? OR LOCATE(?,COALESCE(INFO,''))>0)", timeout: 5_000 }, [database, database]);
          const [transactions] = await admin.query<RowDataPacket[]>({ sql: "SELECT t.trx_id FROM information_schema.innodb_trx t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ? OR LOCATE(?,COALESCE(t.trx_query,''))>0", timeout: 5_000 }, [database, database]);
          const [locks] = await admin.query<RowDataPacket[]>({ sql: "SELECT OBJECT_NAME FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ?", timeout: 5_000 }, [database]);
          expect(connections).toHaveLength(0); expect(transactions).toHaveLength(0); expect(locks).toHaveLength(0);
          if (!OWNED.test(database) || database === decodeURIComponent(base.pathname.slice(1))) throw new Error("Subagent DROP ownership invalid."); check();
          await admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5_000 }); dropped = true;
        } catch { cleanupErrors.push(new Error(`Subagent fixture successful-run cleanup unproved at ${stage}.`)); }
        finally { await close("cleanup admin", endAdmin); }
      }
      signal.removeEventListener("abort", freezeDiagnostic);
      if (createAttempted && !dropped) console.error(`Subagent fixture database retained: ${database}`);
      // A failed run intentionally retains its database; that is evidence preservation, not a
      // second cleanup failure. A successful run still requires the original exact DROP proof.
      if (passed && (uncertain || !dropped || performance.now() >= deadline)) cleanupErrors.push(new Error(`Subagent fixture successful-run cleanup unproved at ${stage}.`));
      if (cleanupErrors.length) {
        const cleanupError = new AggregateError(cleanupErrors, "Subagent fixture owned cleanup failed.");
        if (primaryFailed) throw new AggregateError([primaryError, cleanupError], "Subagent native MySQL vertical and owned cleanup failed.");
        throw cleanupError;
      }
    }
  }, 45_000);
});
