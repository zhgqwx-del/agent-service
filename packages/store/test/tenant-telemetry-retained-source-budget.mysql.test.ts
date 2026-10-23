import { CaptureMysqlRuntimeOwner, type CaptureMysqlInspection as Connection } from "./fixtures/capture-mysql-runtime.js";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import mysql, { type Connection as NativeMysqlConnection, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MysqlSessionStore,
  TenantTelemetryRetainedSourceIntegrityError,
  newErasureRequestId,
  tenantErasureRequestHash,
} from "../src/index.js";
import { activateCurrentCaptureFixture, captureRefKey } from "./persisted-provider-capture.fixture.js";

// Only this suite's newly created local database is used. No .env, external
// object adapter, application gate, business database, or physical purge runs.
// Empty, explicitly sealed new-tenant T1 cohorts still use the real new-family
// transaction and SQL guards; they are not fake receipts or early-config errors.
const BASE_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const FIXED_BUDGET = 1_048_576;
const ROOT_TRIGGER_NAMES = [
  "trg_tt_retained_t1_roots_bi",
  "trg_tt_retained_catalog_roots_bi",
  "trg_tt_retained_usage_roots_bi",
  "trg_tt_retained_canonical_roots_bi",
] as const;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const segments = url.pathname.split("/").filter(Boolean);
  const name = decodeURIComponent(segments.at(-1) ?? "");
  if (url.protocol !== "mysql:"
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || segments.length !== 1 || url.search || url.hash
    || !/(?:^|[_-])test(?:$|[_-])/i.test(name)) {
    throw new Error("0054 budget fixture requires a local disposable MySQL test base");
  }
  return url;
}

function budget(row: RowDataPacket | undefined): number {
  const value = row?.root_budget;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("budget fixture did not observe one safe native session value");
  }
  return value;
}

type AdmissionInput = Parameters<MysqlSessionStore["requestTenantErasure"]>[0];
type Query = (...args: unknown[]) => Promise<unknown>;
type ConnectionSurface = {
  query: Query;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  release: () => void;
  destroy: () => void;
};
type PoolSurface = { getConnection: () => Promise<PoolConnection> };
type BudgetProbe = {
  acquired: number;
  setupCompleted: number;
  setupBudget: number | null;
  receiptInsertHits: number;
  receiptBudget: number | null;
  insertedReceiptBeforeLateFailure: number;
  restoreAttempts: number;
  restoredBudget: number | null;
  commitCompleted: number;
  rollbackAttempts: number;
  rollbackCompleted: number;
  explicitReleases: number;
  destroys: number;
  lateSqlError: unknown;
  setupLoss: Error;
  restoreLoss: Error;
};
type ProbeOptions = {
  previous: number;
  loseSetupResponse?: boolean;
  failRestore?: boolean;
  lateSqlFailure?: boolean;
};

async function readNativeBudget(query: Query, connection: PoolConnection): Promise<number> {
  const [rows] = await query.call(connection,
    "SELECT @@SESSION.group_concat_max_len AS root_budget") as [RowDataPacket[], unknown];
  if (rows.length !== 1) throw new Error("budget fixture session observation is not singular");
  return budget(rows[0]);
}

// Inject only after a real pool connection and native SET/INSERT have succeeded.
// All wrappers are restored even if an assertion fails. The application chooses
// whether to release or destroy; fixture cleanup never increments that evidence.
async function withBudgetProbe<T>(store: MysqlSessionStore, request: AdmissionInput,
  options: ProbeOptions, inspect: (probe: BudgetProbe) => Promise<T>): Promise<T> {
  const pool = (store as unknown as { pool: PoolSurface }).pool;
  const originalGetConnection = pool.getConnection;
  const getConnection = originalGetConnection.bind(pool);
  const probe: BudgetProbe = {
    acquired: 0, setupCompleted: 0, setupBudget: null,
    receiptInsertHits: 0, receiptBudget: null, insertedReceiptBeforeLateFailure: 0,
    restoreAttempts: 0, restoredBudget: null,
    commitCompleted: 0, rollbackAttempts: 0, rollbackCompleted: 0,
    explicitReleases: 0, destroys: 0, lateSqlError: undefined,
    setupLoss: new Error("fixture native budget SET response lost"),
    restoreLoss: new Error("fixture native budget restore failed"),
  };
  let connection: PoolConnection | undefined;
  let original: ConnectionSurface | undefined;
  pool.getConnection = async () => {
    const current = await getConnection();
    if (connection) return current;
    connection = current;
    probe.acquired++;
    const surface = current as unknown as ConnectionSurface;
    original = { query: surface.query, commit: surface.commit, rollback: surface.rollback,
      release: surface.release, destroy: surface.destroy };
    // This is a fixture session setting, before the real T1 starts. It is not a
    // change to the global server setting or to any other pooled connection.
    try {
      await original.query.call(current, "SET SESSION group_concat_max_len=?", [options.previous]);
      expect(await readNativeBudget(original.query, current)).toBe(options.previous);
    } catch (error) {
      original.destroy.call(current);
      throw error;
    }
    const native = original;
    surface.query = async (...args: unknown[]) => {
      const sql = args[0];
      if (sql === "SET SESSION group_concat_max_len=1048576") {
        const result = await native.query.apply(current, args);
        probe.setupCompleted++;
        probe.setupBudget = await readNativeBudget(native.query, current);
        if (options.loseSetupResponse) throw probe.setupLoss;
        return result;
      }
      if (sql === "SET SESSION group_concat_max_len=?" && probe.setupCompleted > 0) {
        probe.restoreAttempts++;
        expect(args[1]).toEqual([options.previous]);
        if (options.failRestore) throw probe.restoreLoss;
        const result = await native.query.apply(current, args);
        probe.restoredBudget = await readNativeBudget(native.query, current);
        return result;
      }
      if (typeof sql === "string"
        && /^\s*INSERT INTO tenant_telemetry_retained_source_t1_receipts\s*\(/.test(sql)) {
        probe.receiptInsertHits++;
        probe.receiptBudget = await readNativeBudget(native.query, current);
        const result = await native.query.apply(current, args);
        if (options.lateSqlFailure) {
          const [rows] = await native.query.call(current,
            "SELECT COUNT(*) AS n FROM tenant_telemetry_retained_source_t1_receipts WHERE BINARY request_id=BINARY ?",
            [request.requestId]) as [RowDataPacket[], unknown];
          expect(rows).toHaveLength(1);
          expect(rows[0]?.n).toBe(1);
          probe.insertedReceiptBeforeLateFailure++;
          try {
            // A genuine server SQL error after the receipt INSERT, not a
            // preflight rejection or an application-side synthetic success.
            // The current closed runtime has no grant for this test-only name.
            // MySQL returns its exact access-denied error before table existence;
            // keep the native query, actual error identity and rollback checks.
            await native.query.call(current, "SELECT 1 FROM fixture_0054_budget_missing_table");
          } catch (error) {
            probe.lateSqlError = error;
            throw error;
          }
          throw new Error("budget fixture missing-table failure did not occur");
        }
        return result;
      }
      return native.query.apply(current, args);
    };
    surface.commit = async () => {
      await native.commit.call(current);
      probe.commitCompleted++;
    };
    surface.rollback = async () => {
      probe.rollbackAttempts++;
      await native.rollback.call(current);
      probe.rollbackCompleted++;
    };
    surface.release = () => { probe.explicitReleases++; native.release.call(current); };
    surface.destroy = () => { probe.destroys++; native.destroy.call(current); };
    return current;
  };
  try {
    return await inspect(probe);
  } finally {
    pool.getConnection = originalGetConnection;
    if (connection && original) {
      const surface = connection as unknown as ConnectionSurface;
      surface.query = original.query;
      surface.commit = original.commit;
      surface.rollback = original.rollback;
      surface.release = original.release;
      surface.destroy = original.destroy;
      // An unexpected test failure must not leak a borrowed connection. Never
      // return it to the pool with an unverified session budget or transaction.
      if (probe.explicitReleases === 0 && probe.destroys === 0) original.destroy.call(connection);
    }
  }
}

async function assertPublicationState(conn: Connection, request: AdmissionInput,
  published: boolean): Promise<void> {
  const tables = ["tenant_erasure_admissions", "erasure_audit_events",
    "tenant_credential_revocation_fences", "tenant_telemetry_lifecycle_subjects",
    "tenant_telemetry_retained_source_t1_receipts", "tenant_credential_revocation_jobs",
    "tenant_restore_journal_jobs", "tenant_restore_journal_targets"] as const;
  for (const table of tables) {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE BINARY request_id=BINARY ?`, [request.requestId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.n).toBe(published ? 1 : 0);
  }
  const [leaves] = await conn.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM tenant_telemetry_retained_source_t1_entries WHERE BINARY request_id=BINARY ?",
    [request.requestId],
  );
  expect(leaves).toHaveLength(1);
  expect(leaves[0]?.n).toBe(0); // These are genuine explicitly sealed empty cohorts.
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT state,generation,active_request_id FROM subject_lifecycle WHERE BINARY tenant_id=BINARY ? AND subject_kind='tenant' AND BINARY subject_id=BINARY ?",
    [request.tenantId, request.tenantId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject(published
    ? { state: "deleting", generation: 1, active_request_id: request.requestId }
    : { state: "active", generation: 0, active_request_id: null });
}

function rootCapSource(sql: string) {
  if (Buffer.byteLength(sql) > FIXED_BUDGET) throw new Error("budget fixture source exceeds its read budget");
  const projections = ROOT_TRIGGER_NAMES.map((name) => {
    const lines = sql.split("\n").filter((line) => line.startsWith(`CREATE TRIGGER ${name} `));
    if (lines.length !== 1) throw new Error("budget fixture root trigger is not exact");
    const start = lines[0]!.indexOf("IF (");
    const end = lines[0]!.indexOf(" AND BINARY NEW.", start);
    if (start < 0 || end < 0) throw new Error("budget fixture root cap source is absent");
    const expression = lines[0]!.slice(start + 4, end);
    const lhs = name === "trg_tt_retained_catalog_roots_bi"
      ? "GREATEST(NEW.entry_count,NEW.source_count,NEW.unknown_group_count)" : "NEW.entry_count";
    if (expression !== `${lhs}<=FLOOR((LEAST(@@SESSION.group_concat_max_len,1048576)+1)/136)`) {
      throw new Error("budget fixture root cap source is not the closed fixed-ceiling contract");
    }
    return { name, expression, expressionSha256: sha256(expression),
      selectableExpression: expression.replaceAll(/NEW\.(entry_count|source_count|unknown_group_count)/g, "v.$1") };
  });
  return { sourceSha256: sha256(sql), projections };
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("0054 retained-source: real MySQL scoped root budget causality", () => {
    let base: URL;
    let store: MysqlSessionStore | undefined;
    let conn: Connection | undefined;
    type Fixture = { owner: CaptureMysqlRuntimeOwner; signal: AbortSignal; completed: boolean;
      startup?: Promise<void>; detach?: () => void; close?: Promise<void> };
    const fixtures = new Set<Fixture>();
    let activeFixture: Fixture | undefined;
    function assertCurrent(fixture: Fixture): void {
      fixture.signal.throwIfAborted();
      if (activeFixture !== fixture) throw new Error("Budget fixture was superseded");
    }
    function completeCase(): void {
      if (!activeFixture) throw new Error("Budget fixture owner is unavailable");
      assertCurrent(activeFixture); activeFixture.completed = true;
    }
    function closeFixture(fixture: Fixture): Promise<void> {
      return fixture.close ??= (async () => {
        try { await fixture.owner.close({ successful: fixture.completed && !fixture.signal.aborted }); }
        finally { await Promise.allSettled(fixture.startup ? [fixture.startup] : []); fixture.detach?.(); }
      })();
    }

    function requiredStore(): MysqlSessionStore {
      if (!store) throw new Error("budget fixture store is unavailable");
      return store;
    }
    function requiredConnection(): Connection {
      if (!conn) throw new Error("budget fixture observer is unavailable");
      return conn;
    }
    async function newTenant(): Promise<AdmissionInput> {
      const tenantId = `budget-tenant-${randomBytes(10).toString("hex")}`;
      await requiredStore().createApiKey(tenantId, `fixture-key-${tenantId}`, `fixture-hash-${tenantId}`);
      const [rows] = await requiredConnection().query<RowDataPacket[]>(
        "SELECT CAST(FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000) AS UNSIGNED) AS now_ms",
      );
      const now = rows[0]?.now_ms;
      if (rows.length !== 1 || typeof now !== "number" || !Number.isSafeInteger(now) || now < 1) {
        throw new Error("budget fixture database time is invalid");
      }
      return { requestId: newErasureRequestId(), tenantId,
        requestedByKeyId: "budget-fixture-admin", idempotencyKey: `budget-${newErasureRequestId()}`,
        requestHash: tenantErasureRequestHash(tenantId), atMs: now };
    }

    /** Observe only this owner's real parent-process CREATE; every native receiver/result is retained. */
    async function prepareWithCreateWitness(owner: CaptureMysqlRuntimeOwner): Promise<void> {
      const database = owner.database;
      const createSql = "CREATE DATABASE " + mysql.escapeId(database) + " CHARACTER SET utf8mb4";
      let createCalls = 0;
      const restore: (() => void)[] = [];
      const createConnection = mysql.createConnection;
      const spy = vi.spyOn(mysql, "createConnection").mockImplementation(async (...args) => {
        const actual: NativeMysqlConnection = await Reflect.apply(createConnection, mysql, args);
        const originalQuery = actual.query, query = originalQuery as unknown as Query;
        const wrapped: Query = async (...queryArgs) => {
          const options = queryArgs[0];
          const descriptor = options !== null && typeof options === "object"
            ? Object.getOwnPropertyDescriptor(options, "sql") : undefined;
          if (!descriptor || !("value" in descriptor) || descriptor.value !== createSql) {
            return Reflect.apply(query, actual, queryArgs);
          }
          if (++createCalls !== 1) throw new Error("Budget fixture CREATE was dispatched more than once");
          const [existing] = await Reflect.apply(query, actual, [
            "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database],
          ]) as [RowDataPacket[], unknown];
          expect(existing).toHaveLength(0);
          const result = await Reflect.apply(query, actual, queryArgs);
          const [ack] = result as [mysql.ResultSetHeader, unknown];
          expect(ack.warningStatus).toBe(0);
          const [after] = await Reflect.apply(query, actual, [
            "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database],
          ]) as [RowDataPacket[], unknown];
          expect(after).toHaveLength(1);
          expect(after[0]?.name).toBe(database);
          return result;
        };
        actual.query = wrapped as unknown as typeof actual.query;
        restore.push(() => { if (actual.query === wrapped as unknown as typeof actual.query) actual.query = originalQuery; });
        return actual;
      });
      let failure: { reason: unknown } | undefined;
      try {
        await owner.prepare();
        if (createCalls !== 1) throw new Error("Budget fixture native CREATE was not observed exactly once");
      } catch (reason) { failure = { reason }; }
      finally {
        try { spy.mockRestore(); } catch (reason) { failure ??= { reason }; }
        for (const undo of restore.reverse()) try { undo(); } catch (reason) { failure ??= { reason }; }
      }
      if (failure) throw failure.reason;
    }
    beforeAll(async () => { base = disposableBase(BASE_URL); });
    beforeEach(async ({ signal }) => {
      const owner = new CaptureMysqlRuntimeOwner(base.toString(), { tenantTelemetryRefKey: captureRefKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: false });
      const fixture: Fixture = { owner, signal, completed: false }; activeFixture = fixture; fixtures.add(fixture);
      const abort = () => { void owner.close({ successful: false }).catch(() => { /* closeFixture joins the same original close. */ }); };
      signal.addEventListener("abort", abort, { once: true }); fixture.detach = () => signal.removeEventListener("abort", abort);
      fixture.startup = (async () => {
        assertCurrent(fixture); await prepareWithCreateWitness(owner); assertCurrent(fixture);
        await owner.activatePrimary(); assertCurrent(fixture);
        const opened = await owner.openStore(4, signal); assertCurrent(fixture); store = opened;
        const observed = await owner.openInspection(signal); assertCurrent(fixture); conn = observed;
        await activateCurrentCaptureFixture(opened); assertCurrent(fixture);
      })();
      await fixture.startup;
    }, 120_000);
    afterEach(async () => {
      const fixture = activeFixture; activeFixture = undefined; store = undefined; conn = undefined;
      if (fixture) await closeFixture(fixture);
    });
    afterAll(async () => {
      const results = await Promise.allSettled([...fixtures].map(fixture => closeFixture(fixture)));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });

    it.each([1024, 2 * FIXED_BUDGET])("uses native 1MiB for T1 and restores previous %i", async (previous) => {
      const current = requiredStore();
      const request = await newTenant();
      await withBudgetProbe(current, request, { previous }, async (probe) => {
        expect(await current.requestTenantErasure(request)).toMatchObject({ requestId: request.requestId });
        expect(probe).toMatchObject({ acquired: 1, setupCompleted: 1, setupBudget: FIXED_BUDGET,
          receiptInsertHits: 1, receiptBudget: FIXED_BUDGET, restoreAttempts: 1,
          restoredBudget: previous, commitCompleted: 1, rollbackAttempts: 0,
          explicitReleases: 1, destroys: 0 });
        await assertPublicationState(requiredConnection(), request, true);
      });
      expect(await current.getTenantTelemetryRetainedSourceT1CohortReceipt(request.tenantId, request.requestId))
        .toMatchObject({ entryCount: 0, eligibility: "eligible_retained",
          executionReady: false, externalAuthorityVerified: false, allDomainsComplete: false, contentPurgeExecuted: false });
      completeCase();
    }, 120_000);

    it("restores the previous native budget after an applied SET loses its response", async () => {
      const current = requiredStore();
      const request = await newTenant();
      await withBudgetProbe(current, request, { previous: 1024, loseSetupResponse: true }, async (probe) => {
        await expect(current.requestTenantErasure(request)).rejects.toBe(probe.setupLoss);
        expect(probe).toMatchObject({ acquired: 1, setupCompleted: 1, setupBudget: FIXED_BUDGET,
          receiptInsertHits: 0, restoreAttempts: 1, restoredBudget: 1024,
          commitCompleted: 0, rollbackAttempts: 1, rollbackCompleted: 1,
          explicitReleases: 1, destroys: 0 });
        await assertPublicationState(requiredConnection(), request, false);
      });
      completeCase();
    }, 120_000);

    it("destroys and never releases when setup-response loss cannot restore the native budget", async () => {
      const current = requiredStore();
      const request = await newTenant();
      await withBudgetProbe(current, request,
        { previous: 1024, loseSetupResponse: true, failRestore: true }, async (probe) => {
          await expect(current.requestTenantErasure(request)).rejects.toBe(probe.setupLoss);
          expect(probe).toMatchObject({ acquired: 1, setupCompleted: 1, setupBudget: FIXED_BUDGET,
            receiptInsertHits: 0, restoreAttempts: 1, restoredBudget: null,
            commitCompleted: 0, rollbackAttempts: 1, explicitReleases: 0, destroys: 1 });
          await assertPublicationState(requiredConnection(), request, false);
        });
      completeCase();
    }, 120_000);

    it("keeps an actual committed T1 and exact replay after post-COMMIT restore failure", async () => {
      const current = requiredStore();
      const request = await newTenant();
      let receiptSha256 = "";
      await withBudgetProbe(current, request, { previous: 2 * FIXED_BUDGET, failRestore: true }, async (probe) => {
        await expect(current.requestTenantErasure(request)).rejects.toBeInstanceOf(TenantTelemetryRetainedSourceIntegrityError);
        expect(probe).toMatchObject({ acquired: 1, setupCompleted: 1, setupBudget: FIXED_BUDGET,
          receiptInsertHits: 1, receiptBudget: FIXED_BUDGET, restoreAttempts: 1,
          restoredBudget: null, commitCompleted: 1, rollbackAttempts: 0,
          explicitReleases: 0, destroys: 1 });
        await assertPublicationState(requiredConnection(), request, true);
        const [rows] = await requiredConnection().query<RowDataPacket[]>(
          "SELECT receipt_sha256 FROM tenant_telemetry_retained_source_t1_receipts WHERE BINARY request_id=BINARY ?",
          [request.requestId],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
        receiptSha256 = String(rows[0]!.receipt_sha256);
      });
      expect(await current.requestTenantErasure(request)).toMatchObject({ requestId: request.requestId, generation: 1 });
      expect(await current.getTenantTelemetryRetainedSourceT1CohortReceipt(request.tenantId, request.requestId))
        .toMatchObject({ receiptSha256, entryCount: 0, eligibility: "eligible_retained", allDomainsComplete: false });
      await assertPublicationState(requiredConnection(), request, true);
      completeCase();
    }, 120_000);

    it("rolls back a native late SQL failure and restores the prior session budget", async () => {
      const current = requiredStore();
      const request = await newTenant();
      await withBudgetProbe(current, request, { previous: 1024, lateSqlFailure: true }, async (probe) => {
        const outcome = current.requestTenantErasure(request);
        await expect(outcome).rejects.toMatchObject({ code: "ER_TABLEACCESS_DENIED_ERROR" });
        await expect(outcome).rejects.toBe(probe.lateSqlError);
        expect(probe).toMatchObject({ acquired: 1, setupCompleted: 1, setupBudget: FIXED_BUDGET,
          receiptInsertHits: 1, receiptBudget: FIXED_BUDGET, insertedReceiptBeforeLateFailure: 1,
          restoreAttempts: 1, restoredBudget: 1024, commitCompleted: 0,
          rollbackAttempts: 1, rollbackCompleted: 1, explicitReleases: 1, destroys: 0 });
        await assertPublicationState(requiredConnection(), request, false);
      });
      completeCase();
    }, 120_000);

    it("preserves the native late SQL error and zero publication when restore also fails", async () => {
      const current = requiredStore();
      const request = await newTenant();
      await withBudgetProbe(current, request,
        { previous: 1024, lateSqlFailure: true, failRestore: true }, async (probe) => {
          const outcome = current.requestTenantErasure(request);
          await expect(outcome).rejects.toMatchObject({ code: "ER_TABLEACCESS_DENIED_ERROR" });
          await expect(outcome).rejects.toBe(probe.lateSqlError);
          expect(probe).toMatchObject({ acquired: 1, setupCompleted: 1, setupBudget: FIXED_BUDGET,
            receiptInsertHits: 1, receiptBudget: FIXED_BUDGET, insertedReceiptBeforeLateFailure: 1,
            restoreAttempts: 1, restoredBudget: null, commitCompleted: 0,
            rollbackAttempts: 1, rollbackCompleted: 1, explicitReleases: 0, destroys: 1 });
          await assertPublicationState(requiredConnection(), request, false);
        });
      completeCase();
    }, 120_000);

    it("evaluates the four actual SQL cap expressions with native budgets and 7710/7711 boundaries", async () => {
      // SELECT-only numeric capacity proof, not 7711 real artifacts or deletion.
      const sql = await readFile(new URL("../migrations/0054_tenant_telemetry_retained_source.sql", import.meta.url), "utf8");
      const source = rootCapSource(sql);
      expect(source.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(source.projections.map((row) => row.name)).toEqual([...ROOT_TRIGGER_NAMES]);
      const current = requiredConnection();
      const [before] = await current.query<RowDataPacket[]>("SELECT @@SESSION.group_concat_max_len AS root_budget");
      expect(before).toHaveLength(1);
      const previous = budget(before[0]);
      const matrix = [
        { session: 1024, count: 7, accepted: 1 },
        { session: 1024, count: 8, accepted: 0 },
        { session: FIXED_BUDGET, count: 7710, accepted: 1 },
        { session: FIXED_BUDGET, count: 7711, accepted: 0 },
        { session: 2 * FIXED_BUDGET, count: 7710, accepted: 1 },
        { session: 2 * FIXED_BUDGET, count: 7711, accepted: 0 },
      ];
      let executed = 0;
      try {
        for (const projection of source.projections) for (const vector of matrix) {
          await current.query("SET SESSION group_concat_max_len=?", [vector.session]);
          const [rows] = await current.query<RowDataPacket[]>(
            `SELECT IF((${projection.selectableExpression}) IS TRUE,1,0) AS accepted,
                    @@SESSION.group_concat_max_len AS root_budget,
                    SHA2(?,256) AS expression_sha256
               FROM (SELECT CAST(? AS UNSIGNED) AS entry_count,
                            CAST(? AS UNSIGNED) AS source_count,
                            CAST(? AS UNSIGNED) AS unknown_group_count) v`,
            [projection.expression, vector.count, vector.count, vector.count],
          );
          expect(rows).toHaveLength(1);
          expect(rows[0]?.accepted).toBe(vector.accepted);
          expect(budget(rows[0])).toBe(vector.session);
          expect(rows[0]?.expression_sha256).toBe(projection.expressionSha256);
          executed++;
        }
      } finally {
        await current.query("SET SESSION group_concat_max_len=?", [previous]);
      }
      expect(executed).toBe(24);
      const [after] = await current.query<RowDataPacket[]>("SELECT @@SESSION.group_concat_max_len AS root_budget");
      expect(after).toHaveLength(1);
      expect(budget(after[0])).toBe(previous);
      const [evidence] = await current.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM tenant_telemetry_retained_source_t1_receipts",
      );
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.n).toBe(0);
      completeCase();
    }, 120_000);
  });
}
