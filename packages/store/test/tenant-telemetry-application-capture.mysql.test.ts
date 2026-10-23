import { CaptureMysqlRuntimeOwner, type CaptureMysqlInspection as Connection } from "./fixtures/capture-mysql-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import {
  MysqlSessionStore,
  TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
  TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
  TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  TenantTelemetryApplicationCaptureConflictError,
  TenantTelemetryApplicationCaptureIntegrityError,
  TenantTelemetryWriteConflictError,
  TenantTelemetryWriteIntegrityError,
  type ActivateTenantTelemetryApplicationCaptureInput,
  type EnqueueTenantTelemetryArtifactInput,
  type TenantTelemetryDomain,
} from "../src/index.js";
import { mkSession } from "./conformance.js";
import { trustedRunnerTelemetryRecord } from "./tenant-telemetry-adapter.fixture.js";

const BASE_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const REF_KEY = Buffer.alloc(32, 0x35);
const PRODUCER_PROTOCOL = "application-dual-write-v1";
const PRODUCER_CONTRACT_SHA256 = digest("application-producer-contract");
type Row = RowDataPacket;
type CaseId = "a01" | "a02" | "a03" | "a04" | "a05" | "a06"
  | "a07" | "a08" | "a09" | "a10" | "a11" | "a12";
type Phase = "fixture_create_database" | "fixture_connect_apply" | "fixture_activate_lifecycle"
  | "fixture_raw_connect" | "body" | "cold_connect" | "cold_connect_settled"
  | "gate_enter" | "gate_release" | "gate_body_settle" | "gate_cleanup_settle"
  | "cleanup_trigger_drop" | "cleanup_conn_end" | "cleanup_store_close"
  | "cleanup_drop_database" | "fixture_cleanup_attempts_complete" | "complete";

function caseDiagnostic(caseId: CaseId): (phase: Phase) => void {
  let startedAt: number;
  try { startedAt = performance.now(); } catch { return () => {}; }
  return (phase) => {
    try {
      console.warn(JSON.stringify({ schema: "telemetry-mysql-test-phase-v1",
        suite: "application_capture", caseId, phase,
        elapsedMs: Math.max(0, Math.floor(performance.now() - startedAt)) }));
    } catch { /* Diagnostic failures never alter the real test or cleanup. */ }
  };
}

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(`MYSQL_TEST_URL must name a disposable test database, got ${database}`);
  }
  return url;
}

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

const lifecycleActivation = () => ({
  expectedControlGeneration: 0 as const,
  targets: [
    {
      domain: "logs" as const,
      backendKind: "test_sink",
      adapterProtocol: "telemetry-test-v1",
      namespaceSha256: digest("application:logs:namespace"),
      failureDomainSha256: digest("application:logs:failure-domain"),
    },
    {
      domain: "traces" as const,
      backendKind: "test_sink",
      adapterProtocol: "telemetry-test-v1",
      namespaceSha256: digest("application:traces:namespace"),
      failureDomainSha256: digest("application:traces:failure-domain"),
    },
  ],
});

async function captureActivation(
  store: MysqlSessionStore,
  domain: TenantTelemetryDomain,
  producerContractSha256 = PRODUCER_CONTRACT_SHA256,
): Promise<ActivateTenantTelemetryApplicationCaptureInput> {
  const lifecycleControl = await store.getTenantTelemetryLifecycleControl();
  if (lifecycleControl.state !== "active") throw new Error("fixture lifecycle is inactive");
  const target = (await store.listTenantTelemetryLifecycleTargets())
    .find((candidate) => candidate.domain === domain);
  if (!target) throw new Error(`fixture ${domain} target is missing`);
  return {
    domain,
    expectedControlGeneration: 0,
    expectedLifecycleControlGeneration: 1,
    lifecycleControlEvidenceSha256: lifecycleControl.activationEvidenceSha256,
    lifecycleTargetSha256: target.targetSha256,
    lifecycleTargetReceiptSha256: target.receiptSha256,
    producerProtocol: PRODUCER_PROTOCOL,
    producerContractSha256,
    fleetStoppedAck: TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
    legacyWritersDrainedAck:
      TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
    producerReadyAck: TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  };
}

function writeInput(
  tenantId: string,
  marker: string,
  options: {
    domain?: TenantTelemetryDomain;
    producerProtocol?: string;
    producerContractSha256?: string;
    ownerKind?: "tenant" | "user" | "session";
    ownerId?: string;
    ownerUserId?: string | null;
  } = {},
): EnqueueTenantTelemetryArtifactInput {
  const domain = options.domain ?? "logs";
  const ownerKind = options.ownerKind ?? "tenant";
  const ownerId = options.ownerId ?? tenantId;
  const atMs = Date.now();
  return {
    tenantId,
    expectedControlGeneration: 1,
    domain,
    artifactIdSha256: digest(`${marker}:artifact`),
    artifactGeneration: 1,
    ownerKind,
    ownerId,
    ownerUserId: options.ownerUserId ?? null,
    sourceSchema: "structured-log-batch-v1",
    sourceGeneration: 1,
    sourceHighWaterDbMs: atMs,
    ...(options.producerProtocol === undefined
      ? {}
      : { producerProtocol: options.producerProtocol }),
    ...(options.producerContractSha256 === undefined
      ? {}
      : { producerContractSha256: options.producerContractSha256 }),
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain,
      records: [trustedRunnerTelemetryRecord(atMs, {
        opaqueRefKey: REF_KEY,
        tenantValue: tenantId,
        ownerKind,
        ownerValue: ownerId,
      })],
    },
  };
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant telemetry application capture", () => {
    let base: URL;
    type Scope = { signal: AbortSignal; failed: boolean; failure?: { reason: unknown };
      owner?: CaptureMysqlRuntimeOwner; close?: Promise<void>; work?: Promise<void>; detach?: () => void;
      cleanupValidation?: "structure-after-intentional-data-corruption-v1" };
    const cases = new Set<Scope>();
    function finish(scope: Scope): Promise<void> {
      return scope.close ??= (async () => {
        try { await scope.owner?.close({ successful: !scope.failed && !scope.signal.aborted,
          ...(scope.cleanupValidation ? { cleanupValidation: scope.cleanupValidation } : {}) }); }
        finally { scope.detach?.(); }
      })();
    }
    function runCase(body: (scope: Scope) => Promise<void>) {
      return (context: TestContext): Promise<void> => {
        const scope: Scope = { signal: context.signal, failed: false }; cases.add(scope);
        const work = Promise.resolve().then(async () => {
          try { scope.signal.throwIfAborted(); await body(scope); scope.signal.throwIfAborted(); }
          catch (reason) { scope.failed = true; scope.failure ??= { reason }; }
          try { await finish(scope); } catch (reason) { scope.failed = true; scope.failure ??= { reason }; }
          if (scope.failure) throw scope.failure.reason;
        });
        scope.work = work; return work;
      };
    }
    beforeAll(async () => { base = disposableBase(BASE_URL); });
    afterAll(async () => {
      await Promise.allSettled([...cases].map(scope => scope.work!));
      const results = await Promise.allSettled([...cases].map(scope => finish(scope)));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
    function createOwner(scope: Scope, refKey: Uint8Array | null = REF_KEY): CaptureMysqlRuntimeOwner {
      const owner = new CaptureMysqlRuntimeOwner(base.toString(), { tenantTelemetryRefKey: refKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: false, tenantTelemetryCaptureRestoreLocalOnly: false });
      scope.owner = owner;
      const abort = () => { void owner.close({ successful: false }).catch(() => { /* finish joins the same original close. */ }); };
      scope.signal.addEventListener("abort", abort, { once: true });
      scope.detach = () => scope.signal.removeEventListener("abort", abort);
      scope.signal.throwIfAborted(); return owner;
    }

    async function fixture(scope: Scope, caseId: CaseId, options: { activateLifecycle?: boolean } = {}): Promise<{
      database: string; url: string; store: MysqlSessionStore; conn: Connection; owner: CaptureMysqlRuntimeOwner;
      phase(phase: Phase): void; close(): Promise<void>;
    }> {
      const phase = caseDiagnostic(caseId), owner = createOwner(scope), database = owner.database;
      phase("fixture_create_database"); await owner.prepare();
      const url = owner.runtimeEnv().MYSQL_URL!;
      phase("fixture_connect_apply"); const store = await owner.openStore(12, scope.signal);
      if (options.activateLifecycle !== false) {
        phase("fixture_activate_lifecycle"); await store.activateTenantTelemetryLifecycle(lifecycleActivation());
      }
      phase("fixture_raw_connect"); const conn = await owner.openInspection(scope.signal);
      phase("body");
      return { database, url, store, conn, owner, phase, async close() {
        phase("cleanup_conn_end"); await conn.end();
        phase("cleanup_store_close"); await store.close();
        phase("cleanup_drop_database"); await finish(scope); phase("complete");
      } };
    }

    it("activates logs and traces independently with exact replay and conflict detection", runCase(async scope => {
      const ctx = await fixture(scope, "a01");
      try {
        const tenantId = "mysql-app-capture-legacy";
        await ctx.store.createApiKey(tenantId, "key", digest("legacy-key"));

        const logsInput = await captureActivation(ctx.store, "logs");
        const [logs, logsReplay] = await Promise.all([
          ctx.store.activateTenantTelemetryApplicationCapture(logsInput),
          ctx.store.activateTenantTelemetryApplicationCapture(logsInput),
        ]);
        expect(logsReplay).toEqual(logs);
        expect(logs.control).toMatchObject({
          domain: "logs",
          state: "active",
          controlGeneration: 1,
          coverageCount: 1,
          preCutoverWriteCount: 0,
        });
        expect(await ctx.store.getTenantTelemetryApplicationCoverage(tenantId, "logs"))
          .toMatchObject({
            captureStatus: "capture_since_cutover",
            preCutoverHistoryStatus: "pre_cutover_history_unknown",
            lifecycleHistoryStatus: "complete_since_creation",
          });
        expect(await ctx.store.activateTenantTelemetryApplicationCapture(logsInput))
          .toEqual(logs);
        await expect(ctx.store.activateTenantTelemetryApplicationCapture({
          ...logsInput,
          producerContractSha256: digest("conflicting-producer-contract"),
        })).rejects.toBeInstanceOf(TenantTelemetryApplicationCaptureConflictError);

        expect(await ctx.store.getTenantTelemetryApplicationDomainControl("traces"))
          .toEqual({ domain: "traces", state: "inactive", controlGeneration: 0 });
        expect(await ctx.store.getTenantTelemetryApplicationCoverage(tenantId, "traces"))
          .toBeNull();
        const traces = await ctx.store.activateTenantTelemetryApplicationCapture(
          await captureActivation(ctx.store, "traces", digest("traces-producer-contract")),
        );
        expect(traces.control).toMatchObject({
          domain: "traces",
          state: "active",
          producerContractSha256: digest("traces-producer-contract"),
        });
        expect((await ctx.store.listTenantTelemetryApplicationDomainControls())
          .map((control) => [control.domain, control.state]))
          .toEqual([["logs", "active"], ["traces", "active"]]);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("rolls back every activation row when receipt publication fails", runCase(async scope => {
      const ctx = await fixture(scope, "a02");
      const triggerName = `test_tt_app_activation_rollback_${randomUUID()
        .replaceAll("-", "").slice(0, 8)}`;
      try {
        const tenantId = "mysql-app-activation-rollback";
        await ctx.store.createApiKey(tenantId, "key", digest("activation-rollback-key"));
        await ctx.conn.query(
          `CREATE TRIGGER \`${triggerName}\` BEFORE INSERT
             ON tenant_telemetry_application_activation_receipts FOR EACH ROW
           SIGNAL SQLSTATE '45000'
             SET MESSAGE_TEXT='injected application activation receipt failure'`,
        );
        await expect(ctx.store.activateTenantTelemetryApplicationCapture(
          await captureActivation(ctx.store, "logs"),
        )).rejects.toThrow("injected application activation receipt failure");
        expect(await ctx.store.getTenantTelemetryApplicationDomainControl("logs"))
          .toEqual({ domain: "logs", state: "inactive", controlGeneration: 0 });
        expect(await ctx.store.getTenantTelemetryApplicationCoverage(tenantId, "logs"))
          .toBeNull();
        expect(await ctx.store.getTenantTelemetryApplicationActivationReceipt("logs"))
          .toBeNull();
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        ctx.phase("cleanup_trigger_drop");
        await ctx.conn.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``).catch(() => {});
        await ctx.close();
      }
    }));

    it("creates distinct tenant sessions concurrently without missing-row gap deadlocks", runCase(async scope => {
      const ctx = await fixture(scope, "a03");
      try {
        const sessions = Array.from({ length: 12 }, (_, index) => mkSession(
          `mysql-app-parallel-tenant-${index}`,
          `mysql-app-parallel-user-${index}`,
        ));
        const results = await Promise.all(sessions.map((session) =>
          ctx.store.createSession(session)));
        expect(results.every((result) => result.lastSeq === 1)).toBe(true);

        const [rows] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM sessions
               WHERE tenant_id LIKE 'mysql-app-parallel-tenant-%') AS sessions,
             (SELECT COUNT(*) FROM events e JOIN sessions s ON s.session_id=e.session_id
               WHERE s.tenant_id LIKE 'mysql-app-parallel-tenant-%'
                 AND e.seq=1 AND e.type='session/created') AS creation_events,
             (SELECT COUNT(*) FROM subject_lifecycle
               WHERE tenant_id LIKE 'mysql-app-parallel-tenant-%'
                 AND subject_kind='tenant' AND BINARY subject_id=BINARY tenant_id)
               AS canonical_tenants,
             (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_coverages
               WHERE tenant_id LIKE 'mysql-app-parallel-tenant-%') AS lifecycle_coverages,
             (SELECT COUNT(*) FROM tenant_telemetry_application_coverages
               WHERE tenant_id LIKE 'mysql-app-parallel-tenant-%') AS application_coverages`,
        );
        expect(rows[0]).toMatchObject({
          sessions: 12,
          creation_events: 12,
          canonical_tenants: 12,
          lifecycle_coverages: 12,
          application_coverages: 0,
        });

        await ctx.store.activateTenantTelemetryApplicationCapture(
          await captureActivation(ctx.store, "logs"),
        );
        const activeSessions = Array.from({ length: 12 }, (_, index) => mkSession(
          `mysql-app-active-parallel-tenant-${index}`,
          `mysql-app-active-parallel-user-${index}`,
        ));
        await expect(Promise.all(activeSessions.map((session) =>
          ctx.store.createSession(session)))).resolves.toHaveLength(12);
        const [activeRows] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_coverages
               WHERE tenant_id LIKE 'mysql-app-active-parallel-tenant-%')
               AS lifecycle_coverages,
             (SELECT COUNT(*) FROM tenant_telemetry_application_coverages
               WHERE tenant_id LIKE 'mysql-app-active-parallel-tenant-%'
                 AND domain='logs' AND capture_status='capture_since_tenant_creation')
               AS logs_coverages,
             (SELECT COUNT(*) FROM tenant_telemetry_application_coverages
               WHERE tenant_id LIKE 'mysql-app-active-parallel-tenant-%' AND domain='traces')
               AS traces_coverages,
             (SELECT SUM(telemetry_logs_capture_generation) FROM subject_lifecycle
               WHERE tenant_id LIKE 'mysql-app-active-parallel-tenant-%'
                 AND subject_kind='tenant' AND BINARY subject_id=BINARY tenant_id)
               AS logs_generation,
             (SELECT SUM(telemetry_traces_capture_generation) FROM subject_lifecycle
               WHERE tenant_id LIKE 'mysql-app-active-parallel-tenant-%'
                 AND subject_kind='tenant' AND BINARY subject_id=BINARY tenant_id)
               AS traces_generation`,
        );
        expect(activeRows[0]).toMatchObject({
          lifecycle_coverages: 12,
          logs_coverages: 12,
          traces_coverages: 0,
          logs_generation: "12",
          traces_generation: "0",
        });
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("creates active-domain tenant coverage atomically and rolls back its owner on failure", runCase(async scope => {
      const ctx = await fixture(scope, "a04");
      const triggerName = `test_tt_app_tenant_rollback_${randomUUID()
        .replaceAll("-", "").slice(0, 8)}`;
      try {
        await ctx.store.activateTenantTelemetryApplicationCapture(
          await captureActivation(ctx.store, "logs"),
        );
        const rawTenantId = "mysql-app-raw-session-tenant";
        const rawSessionId = "sess_mysql_app_raw_missing_tenant";
        await expect(ctx.conn.query(
          `INSERT INTO sessions
             (session_id,tenant_id,user_id,agent_id,agent_version,status,title,parent_session_id,
              last_seq,fence_token,context_epoch,usage_json,auto_approved_tools,metadata,
              created_at_ms,updated_at_ms,archived_at_ms)
           VALUES (?,?,?,'agent-default',1,?,NULL,NULL,0,0,'epoch',?,JSON_ARRAY(),?,1,1,NULL)`,
          [
            rawSessionId,
            rawTenantId,
            "mysql-app-raw-session-user",
            JSON.stringify({ type: "idle" }),
            JSON.stringify({}),
            JSON.stringify({}),
          ],
        )).rejects.toThrow("session tenant lacks atomic application capture coverage");
        const [rawRows] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM sessions WHERE session_id=?) AS sessions,
             (SELECT COUNT(*) FROM subject_lifecycle WHERE tenant_id=?) AS subjects,
             (SELECT COUNT(*) FROM tenant_telemetry_application_coverages WHERE tenant_id=?)
               AS coverages`,
          [rawSessionId, rawTenantId, rawTenantId],
        );
        expect(rawRows[0]).toMatchObject({ sessions: 0, subjects: 0, coverages: 0 });

        const tenantId = "mysql-app-new-tenant";
        await ctx.store.createApiKey(tenantId, "key", digest("new-tenant-key"));
        expect(await ctx.store.getTenantTelemetryApplicationCoverage(tenantId, "logs"))
          .toMatchObject({
            captureStatus: "capture_since_tenant_creation",
            preCutoverHistoryStatus: "pre_cutover_not_applicable",
            lifecycleHistoryStatus: "complete_since_creation",
          });
        expect(await ctx.store.getTenantTelemetryApplicationCoverage(tenantId, "traces"))
          .toBeNull();
        const [subjectRows] = await ctx.conn.query<Row[]>(
          `SELECT telemetry_logs_capture_generation,telemetry_traces_capture_generation
             FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='tenant' AND BINARY subject_id=BINARY tenant_id`,
          [tenantId],
        );
        expect(subjectRows[0]).toMatchObject({
          telemetry_logs_capture_generation: 1,
          telemetry_traces_capture_generation: 0,
        });

        await ctx.conn.query(
          `CREATE TRIGGER \`${triggerName}\` BEFORE INSERT
             ON tenant_telemetry_application_coverages FOR EACH ROW
           SIGNAL SQLSTATE '45000'
             SET MESSAGE_TEXT='injected application tenant coverage failure'`,
        );
        const rollbackTenantId = "mysql-app-new-tenant-rollback";
        const rollbackKeyHash = digest("new-tenant-rollback-key");
        await expect(ctx.store.createApiKey(
          rollbackTenantId,
          "key",
          rollbackKeyHash,
        )).rejects.toThrow("injected application tenant coverage failure");
        expect(await ctx.store.getTenant(rollbackTenantId)).toBeNull();
        expect(await ctx.store.resolveApiKey(rollbackKeyHash)).toBeNull();
        const [rollbackRows] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM subject_lifecycle WHERE tenant_id=?) AS subjects,
             (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_coverages WHERE tenant_id=?)
               AS lifecycle_coverages,
             (SELECT COUNT(*) FROM tenant_telemetry_application_coverages WHERE tenant_id=?)
               AS application_coverages,
             (SELECT COUNT(*) FROM api_keys WHERE tenant_id=?) AS api_keys`,
          [rollbackTenantId, rollbackTenantId, rollbackTenantId, rollbackTenantId],
        );
        expect(rollbackRows[0]).toMatchObject({
          subjects: 0,
          lifecycle_coverages: 0,
          application_coverages: 0,
          api_keys: 0,
        });
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        ctx.phase("cleanup_trigger_drop");
        await ctx.conn.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``).catch(() => {});
        await ctx.close();
      }
    }));

    it("serializes activation with tenant creation without leaving a coverage gap", runCase(async scope => {
      const ctx = await fixture(scope, "a05");
      const gateName = `tt_app_activation_${randomUUID().replaceAll("-", "")}`;
      const triggerName = `test_tt_app_activation_tenant_race_${randomUUID()
        .replaceAll("-", "").slice(0, 8)}`;
      let gateHeld = false;
      let activationSettled = false;
      let creationSettled = false;
      let pendingActivation: Promise<Awaited<ReturnType<
        typeof ctx.store.activateTenantTelemetryApplicationCapture
      >>> | undefined;
      let pendingCreation: Promise<void> | undefined;
      try {
        await ctx.store.createApiKey(
          "mysql-app-activation-race-existing",
          "key",
          digest("activation-race-existing-key"),
        );
        ctx.phase("gate_enter");
        const [gateRows] = await ctx.conn.query<Row[]>("SELECT GET_LOCK(?, 0) AS acquired", [
          gateName,
        ]);
        expect(Number(gateRows[0]?.acquired)).toBe(1);
        gateHeld = true;
        await ctx.conn.query(
          `CREATE TRIGGER \`${triggerName}\` BEFORE INSERT
             ON tenant_telemetry_application_coverages FOR EACH ROW
           BEGIN
             IF NEW.capture_status='capture_since_cutover' THEN
               SET @tt_app_gate_acquired = GET_LOCK('${gateName}', 10);
               SET @tt_app_gate_released = RELEASE_LOCK('${gateName}');
             END IF;
           END`,
        );

        pendingActivation = ctx.store.activateTenantTelemetryApplicationCapture(
          await captureActivation(ctx.store, "logs"),
        ).finally(() => { activationSettled = true; });
        const deadline = Date.now() + 5_000;
        let blockedOnGate = false;
        while (Date.now() < deadline) {
          const [rows] = await ctx.conn.query<Row[]>("SHOW FULL PROCESSLIST");
          if (rows.some((row) => `${String(row.State ?? "")} ${String(row.Info ?? "")}`
            .includes("User lock"))) {
            blockedOnGate = true;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        expect(blockedOnGate).toBe(true);
        expect(activationSettled).toBe(false);

        const tenantId = "mysql-app-activation-tenant-race";
        pendingCreation = ctx.store.createApiKey(
          tenantId,
          "key",
          digest("activation-tenant-race-key"),
        ).then(() => undefined).finally(() => { creationSettled = true; });
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(activationSettled).toBe(false);
        expect(creationSettled).toBe(false);

        ctx.phase("gate_release");
        const [releaseRows] = await ctx.conn.query<Row[]>("SELECT RELEASE_LOCK(?) AS released", [
          gateName,
        ]);
        expect(Number(releaseRows[0]?.released)).toBe(1);
        gateHeld = false;
        ctx.phase("gate_body_settle");
        await expect(pendingActivation).resolves.toMatchObject({
          control: { domain: "logs", state: "active" },
        });
        await expect(pendingCreation).resolves.toBeUndefined();
        expect(await ctx.store.getTenantTelemetryApplicationCoverage(tenantId, "logs"))
          .toMatchObject({
            tenantId,
            captureStatus: "capture_since_tenant_creation",
            preCutoverHistoryStatus: "pre_cutover_not_applicable",
          });
        const [rows] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_application_coverages
               WHERE tenant_id=? AND domain='logs') AS coverages,
             (SELECT telemetry_logs_capture_generation FROM subject_lifecycle
               WHERE tenant_id=? AND subject_kind='tenant' AND BINARY subject_id=BINARY tenant_id)
               AS capture_generation`,
          [tenantId, tenantId],
        );
        expect(rows[0]).toMatchObject({ coverages: 1, capture_generation: 1 });
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        if (gateHeld) ctx.phase("gate_release");
        if (gateHeld) await ctx.conn.query("SELECT RELEASE_LOCK(?)", [gateName]).catch(() => {});
        ctx.phase("gate_cleanup_settle");
        await Promise.allSettled([
          ...(pendingActivation ? [pendingActivation] : []),
          ...(pendingCreation ? [pendingCreation] : []),
        ]);
        ctx.phase("cleanup_trigger_drop");
        await ctx.conn.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``).catch(() => {});
        await ctx.close();
      }
    }));

    it("linearizes same-domain enqueue before activation without deadlock or relabeling", runCase(async scope => {
      const ctx = await fixture(scope, "a06");
      const gateName = `tt_app_enqueue_${randomUUID().replaceAll("-", "")}`;
      const triggerName = `test_tt_app_activation_enqueue_race_${randomUUID()
        .replaceAll("-", "").slice(0, 8)}`;
      let gateHeld = false;
      let pendingEnqueue: Promise<Awaited<ReturnType<
        typeof ctx.store.enqueueTenantTelemetryArtifact
      >>> | undefined;
      let pendingActivation: Promise<Awaited<ReturnType<
        typeof ctx.store.activateTenantTelemetryApplicationCapture
      >>> | undefined;
      try {
        const tenantId = "mysql-app-activation-enqueue-race";
        await ctx.store.createApiKey(
          tenantId,
          "key",
          digest("activation-enqueue-race-key"),
        );
        ctx.phase("gate_enter");
        const [gateRows] = await ctx.conn.query<Row[]>("SELECT GET_LOCK(?, 0) AS acquired", [
          gateName,
        ]);
        expect(Number(gateRows[0]?.acquired)).toBe(1);
        gateHeld = true;
        await ctx.conn.query(
          `CREATE TRIGGER \`${triggerName}\` BEFORE INSERT
             ON tenant_telemetry_write_jobs FOR EACH ROW
           BEGIN
             SET @tt_app_gate_acquired = GET_LOCK('${gateName}', 10);
             SET @tt_app_gate_released = RELEASE_LOCK('${gateName}');
           END`,
        );

        const legacyInput = writeInput(tenantId, "activation-enqueue-race");
        pendingEnqueue = ctx.store.enqueueTenantTelemetryArtifact(legacyInput);
        const enqueueDeadline = Date.now() + 5_000;
        let enqueueBlockedOnGate = false;
        while (Date.now() < enqueueDeadline) {
          const [rows] = await ctx.conn.query<Row[]>("SHOW FULL PROCESSLIST");
          if (rows.some((row) => `${String(row.State ?? "")} ${String(row.Info ?? "")}`
            .includes("User lock"))) {
            enqueueBlockedOnGate = true;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        expect(enqueueBlockedOnGate).toBe(true);

        pendingActivation = ctx.store.activateTenantTelemetryApplicationCapture(
          await captureActivation(ctx.store, "logs"),
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 50));

        ctx.phase("gate_release");
        const [releaseRows] = await ctx.conn.query<Row[]>("SELECT RELEASE_LOCK(?) AS released", [
          gateName,
        ]);
        expect(Number(releaseRows[0]?.released)).toBe(1);
        gateHeld = false;

        ctx.phase("gate_body_settle");
        const queued = await pendingEnqueue;
        const activated = await pendingActivation;
        expect(activated.control).toMatchObject({
          domain: "logs",
          state: "active",
          preCutoverWriteCount: 1,
        });
        expect(await ctx.store.getTenantTelemetryApplicationWriteBinding(
          tenantId,
          queued.writeOperationSha256,
        )).toBeNull();
        await expect(ctx.store.enqueueTenantTelemetryArtifact(legacyInput)).resolves.toEqual(queued);
        await expect(ctx.store.enqueueTenantTelemetryArtifact({
          ...legacyInput,
          producerProtocol: PRODUCER_PROTOCOL,
          producerContractSha256: PRODUCER_CONTRACT_SHA256,
        })).rejects.toBeInstanceOf(TenantTelemetryWriteConflictError);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        if (gateHeld) ctx.phase("gate_release");
        if (gateHeld) await ctx.conn.query("SELECT RELEASE_LOCK(?)", [gateName]).catch(() => {});
        ctx.phase("gate_cleanup_settle");
        await Promise.allSettled([
          ...(pendingEnqueue ? [pendingEnqueue] : []),
          ...(pendingActivation ? [pendingActivation] : []),
        ]);
        ctx.phase("cleanup_trigger_drop");
        await ctx.conn.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``).catch(() => {});
        await ctx.close();
      }
    }), 30_000);

    it("keeps composed and decomposed Unicode tenant coverage lookups isolated", runCase(async scope => {
      const ctx = await fixture(scope, "a07");
      try {
        const composedTenantId = "mysql-app-unicode-\u00e9";
        const decomposedTenantId = "mysql-app-unicode-e\u0301";
        expect(composedTenantId.normalize("NFD")).toBe(decomposedTenantId);
        await ctx.store.createApiKey(
          composedTenantId,
          "key",
          digest("unicode-composed-tenant-key"),
        );
        await ctx.store.activateTenantTelemetryApplicationCapture(
          await captureActivation(ctx.store, "logs"),
        );

        expect(await ctx.store.getTenantTelemetryApplicationCoverage(composedTenantId, "logs"))
          .toMatchObject({ tenantId: composedTenantId, domain: "logs" });
        expect(await ctx.store.getTenantTelemetryApplicationCoverage(decomposedTenantId, "logs"))
          .toBeNull();
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("keeps a pre-cutover job unbound and permits only its legacy exact replay", runCase(async scope => {
      const ctx = await fixture(scope, "a08");
      try {
        const tenantId = "mysql-app-pre-cutover-job";
        await ctx.store.createApiKey(tenantId, "key", digest("pre-cutover-key"));
        const legacyInput = writeInput(tenantId, "pre-cutover");
        const legacy = await ctx.store.enqueueTenantTelemetryArtifact(legacyInput);
        const activated = await ctx.store.activateTenantTelemetryApplicationCapture(
          await captureActivation(ctx.store, "logs"),
        );
        expect(activated.control).toMatchObject({ preCutoverWriteCount: 1 });
        expect(await ctx.store.enqueueTenantTelemetryArtifact(legacyInput)).toEqual(legacy);
        expect(await ctx.store.getTenantTelemetryApplicationWriteBinding(
          tenantId,
          legacy.writeOperationSha256,
        )).toBeNull();

        await expect(ctx.store.enqueueTenantTelemetryArtifact({
          ...legacyInput,
          producerProtocol: PRODUCER_PROTOCOL,
          producerContractSha256: PRODUCER_CONTRACT_SHA256,
        })).rejects.toBeInstanceOf(TenantTelemetryWriteConflictError);
        const [bindings] = await ctx.conn.query<Row[]>(
          `SELECT COUNT(*) AS count
             FROM tenant_telemetry_application_write_bindings
            WHERE write_operation_sha256=?`,
          [legacy.writeOperationSha256],
        );
        expect(Number(bindings[0]?.count)).toBe(0);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("binds post-cutover writes while preserving legacy lifecycle history", runCase(async scope => {
      const ctx = await fixture(scope, "a09", { activateLifecycle: false });
      try {
        const tenantId = "mysql-app-legacy-lifecycle-write";
        await ctx.store.createApiKey(tenantId, "key", digest("legacy-lifecycle-write-key"));
        await ctx.store.activateTenantTelemetryLifecycle(lifecycleActivation());
        expect(await ctx.store.getTenantTelemetryLifecycleCoverage(tenantId))
          .toMatchObject({ historyStatus: "legacy_history_unknown" });
        await ctx.store.activateTenantTelemetryApplicationCapture(
          await captureActivation(ctx.store, "logs"),
        );
        expect(await ctx.store.getTenantTelemetryApplicationCoverage(tenantId, "logs"))
          .toMatchObject({
            captureStatus: "capture_since_cutover",
            lifecycleHistoryStatus: "legacy_history_unknown",
          });

        const queued = await ctx.store.enqueueTenantTelemetryArtifact(writeInput(
          tenantId,
          "legacy-lifecycle-write",
          {
            producerProtocol: PRODUCER_PROTOCOL,
            producerContractSha256: PRODUCER_CONTRACT_SHA256,
          },
        ));
        expect(queued.inventory.historyStatus).toBe("legacy_history_unknown");
        expect(await ctx.store.getTenantTelemetryApplicationWriteBinding(
          tenantId,
          queued.writeOperationSha256,
        )).toMatchObject({
          tenantId,
          writeOperationSha256: queued.writeOperationSha256,
          lifecycleCoverageEvidenceSha256: queued.inventory.coverageEvidenceSha256,
        });
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("requires an exact producer for new active-domain jobs and preserves tenant ownership", runCase(async scope => {
      const ctx = await fixture(scope, "a10");
      try {
        await ctx.store.activateTenantTelemetryApplicationCapture(
          await captureActivation(ctx.store, "logs"),
        );
        const tenantId = "mysql-app-bound-job";
        await ctx.store.createApiKey(tenantId, "key", digest("bound-job-key"));
        const missing = writeInput(tenantId, "bound-missing");
        await expect(ctx.store.enqueueTenantTelemetryArtifact(missing))
          .rejects.toBeInstanceOf(TenantTelemetryWriteConflictError);
        await expect(ctx.store.enqueueTenantTelemetryArtifact(writeInput(
          tenantId,
          "bound-wrong",
          {
            producerProtocol: PRODUCER_PROTOCOL,
            producerContractSha256: digest("wrong-producer-contract"),
          },
        ))).rejects.toBeInstanceOf(TenantTelemetryWriteConflictError);

        const boundInput = writeInput(tenantId, "bound-success", {
          producerProtocol: PRODUCER_PROTOCOL,
          producerContractSha256: PRODUCER_CONTRACT_SHA256,
        });
        const queued = await ctx.store.enqueueTenantTelemetryArtifact(boundInput);
        const binding = await ctx.store.getTenantTelemetryApplicationWriteBinding(
          tenantId,
          queued.writeOperationSha256,
        );
        expect(binding).toMatchObject({
          tenantId,
          domain: "logs",
          writeOperationSha256: queued.writeOperationSha256,
          producerProtocol: PRODUCER_PROTOCOL,
          producerContractSha256: PRODUCER_CONTRACT_SHA256,
          inventorySha256: queued.inventory.inventorySha256,
          manifestSha256: queued.inventory.manifestSha256,
          payloadSha256: queued.inventory.payloadSha256,
        });
        expect(await ctx.store.getTenantTelemetryArtifactMembership(
          tenantId,
          queued.writeOperationSha256,
        )).toMatchObject({
          writeOperationSha256: queued.writeOperationSha256,
          inventorySha256: queued.inventory.inventorySha256,
          applicationBindingReceiptSha256: binding!.receiptSha256,
        });
        expect(await ctx.store.enqueueTenantTelemetryArtifact(boundInput)).toEqual(queued);
        expect(await ctx.store.getTenantTelemetryApplicationWriteBinding(
          "mysql-app-another-tenant",
          queued.writeOperationSha256,
        )).toBeNull();

        const other = mkSession("mysql-app-owner-other", "mysql-app-owner-other-user");
        await ctx.store.createSession(other);
        await expect(ctx.store.enqueueTenantTelemetryArtifact(writeInput(
          tenantId,
          "cross-tenant-session-owner",
          {
            producerProtocol: PRODUCER_PROTOCOL,
            producerContractSha256: PRODUCER_CONTRACT_SHA256,
            ownerKind: "session",
            ownerId: other.id,
            ownerUserId: other.userId,
          },
        ))).rejects.toThrow();

        await expect(ctx.store.registerTenantTelemetryArtifact({
          tenantId,
          expectedControlGeneration: 1,
          domain: "logs",
          artifactIdSha256: digest("direct-register-artifact"),
          artifactGeneration: 1,
          ownerKind: "tenant",
          ownerId: tenantId,
          ownerUserId: null,
          sourceSchema: "structured-log-batch-v1",
          sourceGeneration: 1,
          sourceHighWaterDbMs: Date.now(),
          payloadSha256: digest("direct-register-payload"),
          manifestSha256: digest("direct-register-manifest"),
        })).rejects.toBeInstanceOf(TenantTelemetryApplicationCaptureConflictError);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));

    it("rolls back binding, job and payload when post-cutover binding publication fails", runCase(async scope => {
      const ctx = await fixture(scope, "a11");
      const triggerName = `test_tt_app_binding_rollback_${randomUUID()
        .replaceAll("-", "").slice(0, 8)}`;
      try {
        await ctx.store.activateTenantTelemetryApplicationCapture(
          await captureActivation(ctx.store, "logs"),
        );
        const tenantId = "mysql-app-binding-rollback";
        await ctx.store.createApiKey(tenantId, "key", digest("binding-rollback-key"));
        await ctx.conn.query(
          `CREATE TRIGGER \`${triggerName}\` BEFORE INSERT
             ON tenant_telemetry_application_write_bindings FOR EACH ROW
           SIGNAL SQLSTATE '45000'
             SET MESSAGE_TEXT='injected application binding failure'`,
        );
        await expect(ctx.store.enqueueTenantTelemetryArtifact(writeInput(
          tenantId,
          "binding-rollback",
          {
            producerProtocol: PRODUCER_PROTOCOL,
            producerContractSha256: PRODUCER_CONTRACT_SHA256,
          },
        ))).rejects.toThrow("injected application binding failure");
        const [rows] = await ctx.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_application_write_bindings
               WHERE tenant_id=?) AS bindings,
             (SELECT COUNT(*) FROM tenant_telemetry_write_jobs WHERE tenant_id=?) AS jobs,
             (SELECT COUNT(*) FROM tenant_telemetry_write_payloads WHERE tenant_id=?) AS payloads,
             (SELECT COUNT(*) FROM tenant_telemetry_artifact_inventory WHERE tenant_id=?)
               AS inventories`,
          [tenantId, tenantId, tenantId, tenantId],
        );
        expect(rows[0]).toMatchObject({ bindings: 0, jobs: 0, payloads: 0, inventories: 0 });
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        ctx.phase("cleanup_trigger_drop");
        await ctx.conn.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``).catch(() => {});
        await ctx.close();
      }
    }));

    it("fails startup when an active post-cutover job loses its immutable binding", runCase(async scope => {
      scope.cleanupValidation = "structure-after-intentional-data-corruption-v1";
      const ctx = await fixture(scope, "a12");
      try {
        await ctx.store.activateTenantTelemetryApplicationCapture(
          await captureActivation(ctx.store, "logs"),
        );
        const tenantId = "mysql-app-startup-drift";
        await ctx.store.createApiKey(tenantId, "key", digest("startup-drift-key"));
        const queued = await ctx.store.enqueueTenantTelemetryArtifact(writeInput(
          tenantId,
          "startup-drift",
          {
            producerProtocol: PRODUCER_PROTOCOL,
            producerContractSha256: PRODUCER_CONTRACT_SHA256,
          },
        ));
        const [triggerRows] = await ctx.conn.query<Row[]>(
          "SHOW CREATE TRIGGER trg_tt_app_write_binding_bd",
        );
        const triggerDdl = String(triggerRows[0]?.["SQL Original Statement"] ?? "");
        expect(triggerDdl).toContain("CREATE");
        await ctx.conn.query("DROP TRIGGER trg_tt_app_write_binding_bd");
        await expect(ctx.conn.query(
          "DELETE FROM tenant_telemetry_application_write_bindings WHERE write_operation_sha256=?",
          [queued.writeOperationSha256],
        )).rejects.toMatchObject({ code: "ER_ROW_IS_REFERENCED_2" });
        // Corrupt only this disposable fixture: 0038's FK now guards the same
        // parent row, so the old deletion fault injection needs to bypass it.
        // Re-enable FK checks before startup to exercise integrity validation.
        await ctx.conn.query("SET FOREIGN_KEY_CHECKS=0");
        try {
          await ctx.conn.query(
            "DELETE FROM tenant_telemetry_application_write_bindings WHERE write_operation_sha256=?",
            [queued.writeOperationSha256],
          );
        } finally {
          await ctx.conn.query("SET FOREIGN_KEY_CHECKS=1");
        }
        await ctx.conn.query(triggerDdl);

        ctx.phase("cold_connect");
        await expect(ctx.owner.openStore(2, scope.signal)).rejects.toBeInstanceOf(TenantTelemetryWriteIntegrityError);
        ctx.phase("cold_connect_settled");
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await ctx.close();
      }
    }));
  });
} else {
  describe("MysqlSessionStore tenant telemetry application capture", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
