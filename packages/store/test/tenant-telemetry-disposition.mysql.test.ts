import { CaptureMysqlRuntimeOwner, type CaptureMysqlInspection as Connection } from "./fixtures/capture-mysql-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
  MysqlSessionStore,
  TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
  TENANT_TELEMETRY_DISPOSITION_JOB_SCOPE,
  TENANT_TELEMETRY_DISPOSITION_FLEET_STOPPED_ACK,
  TENANT_TELEMETRY_DISPOSITION_LEGACY_WRITERS_DRAINED_ACK,
  TENANT_TELEMETRY_DISPOSITION_REPLAY_FENCE_SCOPE,
  TENANT_TELEMETRY_EXTERNAL_AUTHORIZATION_SCOPE,
  tenantTelemetryDispositionExternalEventSha256,
  tenantTelemetryDispositionNextEventRootSha256,
  tenantTelemetryExternalAuthorizationReceiptSha256,
  validateTenantTelemetryDispositionJobRecord,
  tenantRestoreLogicalDatabaseNamespaceSha256,
  tenantRestoreRuntimeEpochSha256,
  type TenantTelemetryDispositionJobRecord,
} from "../src/index.js";
import { dispositionEvidence } from "./tenant-telemetry-disposition.fixture.js";

type Row = RowDataPacket;
type CaseId = "d01" | "d02" | "d03";
type Phase = "fixture_create_database" | "fixture_connect_apply" | "fixture_raw_connect"
  | "fixture_activate_blob" | "fixture_activate_journal" | "fixture_read_journal"
  | "fixture_activate_catalog" | "fixture_activate_lifecycle" | "fixture_read_lifecycle"
  | "body" | "cold_connect" | "cold_connect_settled" | "cold_close" | "cold_close_settled"
  | "cleanup_conn_end" | "cleanup_store_close" | "cleanup_drop_database"
  | "fixture_cleanup_attempts_complete" | "complete";

function caseDiagnostic(caseId: CaseId): (phase: Phase) => void {
  let startedAt: number;
  try { startedAt = performance.now(); } catch { return () => {}; }
  return (phase) => {
    try {
      console.warn(JSON.stringify({ schema: "telemetry-mysql-test-phase-v1",
        suite: "disposition", caseId, phase,
        elapsedMs: Math.max(0, Math.floor(performance.now() - startedAt)) }));
    } catch { /* Diagnostic failures never alter the real test or cleanup. */ }
  };
}

const D = (label: string) => createHash("sha256").update(label).digest("hex");
const REF_KEY = Buffer.alloc(32, 0x36);
const BASE_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error("MYSQL_TEST_URL must name a disposable test database");
  }
  return url;
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant telemetry disposition substrate", () => {
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

    async function fixture(scope: Scope, caseId: CaseId): Promise<{
      database: string; url: string; store: MysqlSessionStore; conn: Connection; owner: CaptureMysqlRuntimeOwner;
      input: Parameters<MysqlSessionStore["activateTenantTelemetryDisposition"]>[0]; phase(phase: Phase): void; close(): Promise<void>;
    }> {
      const phase = caseDiagnostic(caseId), owner = createOwner(scope), database = owner.database;
      phase("fixture_create_database"); await owner.prepare();
      phase("fixture_connect_apply"); let store = await owner.openStore(12, scope.signal);
      phase("fixture_raw_connect"); const conn = await owner.openInspection(scope.signal);
        const logicalDatabaseNamespaceSha256 =
          tenantRestoreLogicalDatabaseNamespaceSha256(
            "telemetry-disposition-mysql-logical-database",
          );
        const restoreTarget = {
          targetOrdinal: 0,
          targetSha256: D("restore-target"),
          failureDomainSha256: D("restore-failure-domain"),
          adapterProtocol: "mysql-restore-journal-v1",
          journalNamespaceSha256: D("restore-journal-namespace"),
        };
        phase("fixture_activate_blob");
        await store.activateBlobStorageControl({
          expectedControlGeneration: 0,
          storageBackend: "s3v1-disposition-test",
          namespaceSha256: D("blob-namespace"),
        });
        phase("fixture_activate_journal");
        await owner.activatePrimary({
          adapterProtocol: restoreTarget.adapterProtocol,
          journalNamespaceSha256: restoreTarget.journalNamespaceSha256,
          logicalDatabaseNamespaceSha256,
          runtimeEpochSha256: tenantRestoreRuntimeEpochSha256(
            `disposition-primary-${randomUUID()}`,
          ),
          targets: [restoreTarget],
          observedHeads: [{
            ...restoreTarget,
            logicalDatabaseNamespaceSha256,
            sealedRemoteSequence: 0,
            sealedHeadRootSha256:
              EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
          }],
        });
        store = await owner.openStore(12, scope.signal);
        phase("fixture_read_journal");
        const journal = await store.getTenantRestoreJournalControl();
        if (journal.controlGeneration !== 1) throw new Error("fixture journal inactive");
        phase("fixture_activate_catalog");
        await store.activateTenantBackupCatalogControl({
          expectedControlGeneration: 0,
          adapterProtocol: "mysql-backup-catalog-v1",
          catalogNamespaceSha256: D("backup-namespace"),
          catalogTargetSha256: D("backup-target"),
          failureDomainSha256: D("backup-failure-domain"),
          logicalDatabaseNamespaceSha256,
          journalControlEvidenceSha256: journal.evidenceSha256,
          retentionPolicySha256: D("backup-retention"),
          minimumRetentionMs: 1,
          minimumRecoverableBackups: 1,
        });
        phase("fixture_activate_lifecycle");
        await store.activateTenantTelemetryLifecycle({
          expectedControlGeneration: 0,
          targets: [
            {
              domain: "logs",
              backendKind: "test_sink",
              adapterProtocol: "telemetry-test-v1",
              namespaceSha256: D("logs-namespace"),
              failureDomainSha256: D("logs-failure-domain"),
            },
            {
              domain: "traces",
              backendKind: "test_sink",
              adapterProtocol: "telemetry-test-v1",
              namespaceSha256: D("traces-namespace"),
              failureDomainSha256: D("traces-failure-domain"),
            },
          ],
        });
        phase("fixture_read_lifecycle");
        const lifecycle = await store.getTenantTelemetryLifecycleControl();
        if (lifecycle.state !== "active") throw new Error("fixture lifecycle inactive");
        phase("body");
      const url = owner.runtimeEnv().MYSQL_URL!;
      return { database, url, store, conn, owner, phase,
          input: {
            expectedControlGeneration: 0,
            expectedLifecycleControlGeneration: 1,
            lifecycleTargetRootSha256: lifecycle.targetRootSha256,
            adapterProtocol: "mysql-telemetry-disposition-journal-v1",
            journalNamespaceSha256: D("disposition-journal-namespace"),
            journalTargetSha256: D("disposition-journal-target"),
            failureDomainSha256: D("disposition-failure-domain"),
            logicalDatabaseNamespaceSha256,
            fleetStoppedAck: TENANT_TELEMETRY_DISPOSITION_FLEET_STOPPED_ACK,
            legacyWritersDrainedAck:
              TENANT_TELEMETRY_DISPOSITION_LEGACY_WRITERS_DRAINED_ACK,
          },
          async close() {
            phase("cleanup_conn_end"); await conn.end(); phase("cleanup_store_close"); await store.close();
            phase("cleanup_drop_database"); await finish(scope); phase("complete");
          } };
    }

    it("starts dormant and keeps legacy logical namespace drift from activating", runCase(async scope => {
      const f = await fixture(scope, "d01");
      try {
        const unicodeTenantId = "租户🌟";
        await f.store.createApiKey(unicodeTenantId, "unicode-key", D("unicode-key"));
        expect(await f.store.getTenantTelemetryLifecycleCoverage(unicodeTenantId))
          .toMatchObject({ tenantId: unicodeTenantId });
        expect(await f.store.getTenantTelemetryDispositionControl()).toMatchObject({
          state: "inactive", controlGeneration: 0,
        });
        expect(await f.store.getTenantTelemetryDispositionJob(
          unicodeTenantId, D("absent-unicode-operation"),
        )).toBeNull();
        expect(await f.store.getTenantTelemetryDispositionActivationReceipt()).toBeNull();
        await expect(f.store.activateTenantTelemetryDisposition({
          ...f.input,
          logicalDatabaseNamespaceSha256: D("physical-database-instead-of-logical"),
        })).rejects.toThrow(/activation source is incomplete/);
        const [rows] = await f.conn.query<Row[]>(
          `SELECT COUNT(*) AS receipts
             FROM tenant_telemetry_disposition_activation_receipts`,
        );
        expect(Number(rows[0]?.receipts)).toBe(0);
        expect(await f.store.materializeTenantTelemetryDispositionJobs({ limit: 10 }))
          .toBe(0);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await f.close();
      }
    }));

    it("rolls back a receipt when the control update fails, then commits one atomic cutover", runCase(async scope => {
      const f = await fixture(scope, "d02");
      try {
        await f.store.createApiKey("生产租户🌟", "unicode-key", D("unicode-key-active"));
        await f.conn.query(
          `CREATE TRIGGER trg_tt_disposition_test_rollback_bu
             BEFORE UPDATE ON tenant_telemetry_disposition_control
             FOR EACH ROW SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT='injected disposition control failure'`,
        );
        await expect(f.store.activateTenantTelemetryDisposition(f.input))
          .rejects.toThrow(/injected disposition control failure/);
        expect(await f.store.getTenantTelemetryDispositionControl()).toMatchObject({
          state: "inactive", controlGeneration: 0,
        });
        const [afterRollback] = await f.conn.query<Row[]>(
          `SELECT COUNT(*) AS receipt_count
             FROM tenant_telemetry_disposition_activation_receipts`,
        );
        expect(Number(afterRollback[0]?.receipt_count)).toBe(0);
        await f.conn.query("DROP TRIGGER trg_tt_disposition_test_rollback_bu");

        const settled = await Promise.allSettled([
          f.store.activateTenantTelemetryDisposition(f.input),
          f.store.activateTenantTelemetryDisposition(f.input),
        ]);
        expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
        const control = await f.store.getTenantTelemetryDispositionControl();
        const receipt = await f.store.getTenantTelemetryDispositionActivationReceipt();
        expect(control.state).toBe("active");
        if (control.state !== "active") throw new Error("control did not activate");
        expect(receipt?.activationEvidenceSha256).toBe(control.activationEvidenceSha256);
        const [counts] = await f.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_disposition_activation_receipts)
               AS receipt_count,
             (SELECT COUNT(*) FROM tenant_telemetry_disposition_jobs) AS job_count,
             (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants)
               AS grant_count`,
        );
        expect(Number(counts[0]?.receipt_count)).toBe(1);
        expect(Number(counts[0]?.job_count)).toBe(0);
        expect(Number(counts[0]?.grant_count)).toBe(0);
        expect(await f.store.claimTenantTelemetryDispositions({
          limit: 10, leaseMs: 1_000, claimToken: "mysql-disposition-claim",
        })).toEqual([]);
        f.phase("cold_connect");
        const reopened = await f.owner.openStore(4, scope.signal);
        f.phase("cold_connect_settled");
        try {
          expect(await reopened.getTenantTelemetryDispositionControl()).toEqual(control);
        } finally {
          f.phase("cold_close");
          await reopened.close();
          f.phase("cold_close_settled");
        }
        const evidence = dispositionEvidence();
        const body = {
          scope: TENANT_TELEMETRY_EXTERNAL_AUTHORIZATION_SCOPE,
          protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
          ...evidence,
          adapterProtocol: f.input.adapterProtocol,
          journalNamespaceSha256: f.input.journalNamespaceSha256,
          journalTargetSha256: f.input.journalTargetSha256,
          failureDomainSha256: f.input.failureDomainSha256,
          logicalDatabaseNamespaceSha256: f.input.logicalDatabaseNamespaceSha256,
        };
        const authorizationReceiptSha256 =
          tenantTelemetryExternalAuthorizationReceiptSha256(body);
        const journalEventSha256 = tenantTelemetryDispositionExternalEventSha256({
          eventType: "delete_authorized",
          dispositionOperationSha256: evidence.dispositionOperationSha256,
          eventReceiptSha256: authorizationReceiptSha256,
        });
        const journalEventRootSha256 = tenantTelemetryDispositionNextEventRootSha256({
          journalSequence: 1,
          previousJournalEventRootSha256:
            EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
          journalEventSha256,
        });
        await expect(f.store.mirrorTenantTelemetryDispositionExternalEvent({
          eventType: "delete_authorized",
          result: {
            ...body,
            authorizationReceiptSha256,
            journalSequence: 1,
            previousJournalEventRootSha256:
              EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
            journalEventSha256,
            journalEventRootSha256,
          },
        })).rejects.toThrow(/unverified external authority head/);
        await expect(f.store.sealTenantTelemetryDispositionReplayFence({
          scope: TENANT_TELEMETRY_DISPOSITION_REPLAY_FENCE_SCOPE,
          protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
          domain: evidence.domain,
          targetSha256: evidence.targetSha256,
          artifactIdSha256: evidence.artifactIdSha256,
          artifactGeneration: evidence.artifactGeneration,
          dispositionOperationSha256: evidence.dispositionOperationSha256,
          authorizationReceiptSha256,
          tombstoneReceiptSha256: D("forged-tombstone-receipt"),
          terminalReceiptSha256: D("forged-terminal-receipt"),
          journalTargetSha256: f.input.journalTargetSha256,
          terminalJournalSequence: 1,
          terminalJournalEventRootSha256: journalEventRootSha256,
          sealedJournalSequence: 1,
          sealedJournalEventRootSha256: journalEventRootSha256,
          restoreRunSha256: null,
          runtimeEpochSha256: null,
        })).rejects.toThrow(/verified external head and restore run/);
        const [externalRows] = await f.conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_events)
               AS event_count,
             (SELECT COUNT(*) FROM tenant_telemetry_disposition_replay_fences)
               AS fence_count`,
        );
        expect(Number(externalRows[0]?.event_count)).toBe(0);
        expect(Number(externalRows[0]?.fence_count)).toBe(0);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await f.close();
      }
    }));

    it("accepts a Unicode tenant in a diagnostic-only 0036 row and rejects startup execution footprint", runCase(async scope => {
      scope.cleanupValidation = "structure-after-intentional-data-corruption-v1";
      const f = await fixture(scope, "d03");
      try {
        await f.store.activateTenantTelemetryDisposition(f.input);
        const evidence = dispositionEvidence(42);
        const tenantId = "café-租户🌟";
        const normalizationAlias = "cafe\u0301-租户🌟";
        const job: TenantTelemetryDispositionJobRecord = {
          scope: TENANT_TELEMETRY_DISPOSITION_JOB_SCOPE,
          protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
          tenantId,
          requestId: "unicode-diagnostic",
          ...evidence,
          phase: "blocked",
          attempts: 0,
          blockedAtDbMs: 1,
          blockedReasonCode: "integrity_conflict",
          createdAtDbMs: 1,
          updatedAtDbMs: 1,
        };
        validateTenantTelemetryDispositionJobRecord(job);
        await f.conn.query(
          `INSERT INTO tenant_telemetry_disposition_jobs
           (disposition_operation_sha256,tenant_id,request_id,scope,protocol,
            domain,target_sha256,artifact_id_sha256,artifact_generation,
            inventory_sha256,write_operation_sha256,t3c_receipt_sha256,
            t3d_plan_receipt_sha256,t3d_plan_entry_receipt_sha256,phase,attempts,
            blocked_at_db_ms,blocked_reason_code,created_at_db_ms,updated_at_db_ms,job_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [job.dispositionOperationSha256, tenantId, job.requestId, job.scope,
            job.protocol, job.domain, job.targetSha256, job.artifactIdSha256,
            job.artifactGeneration, job.inventorySha256, job.writeOperationSha256,
            job.t3cReceiptSha256, job.t3dPlanReceiptSha256,
            job.t3dPlanEntryReceiptSha256, job.phase, job.attempts,
            job.blockedAtDbMs, job.blockedReasonCode,
            job.createdAtDbMs, job.updatedAtDbMs, JSON.stringify(job)],
        );
        expect(await f.store.getTenantTelemetryDispositionJob(
          tenantId, job.dispositionOperationSha256,
        )).toEqual(job);
        const [collationAliasRows] = await f.conn.query<Row[]>(
          `SELECT disposition_operation_sha256
             FROM tenant_telemetry_disposition_jobs
            WHERE tenant_id=? AND disposition_operation_sha256=?`,
          [normalizationAlias, job.dispositionOperationSha256],
        );
        expect(collationAliasRows).toHaveLength(1); // MySQL collation aliases NFC/NFD.
        expect(await f.store.getTenantTelemetryDispositionJob(
          normalizationAlias, job.dispositionOperationSha256,
        )).toBeNull();
        expect(await f.store.getTenantTelemetryDispositionJob(
          "other-tenant", job.dispositionOperationSha256,
        )).toBeNull();
        const overlongEvidence = dispositionEvidence(43);
        const overlongTenantId = "🌟".repeat(65); // 130 UTF-16 code units, 65 scalars.
        const overlongJob = {
          ...job,
          ...overlongEvidence,
          tenantId: overlongTenantId,
        };
        await expect(f.conn.query(
          `INSERT INTO tenant_telemetry_disposition_jobs
           (disposition_operation_sha256,tenant_id,request_id,scope,protocol,
            domain,target_sha256,artifact_id_sha256,artifact_generation,
            inventory_sha256,write_operation_sha256,t3c_receipt_sha256,
            t3d_plan_receipt_sha256,t3d_plan_entry_receipt_sha256,phase,attempts,
            blocked_at_db_ms,blocked_reason_code,created_at_db_ms,updated_at_db_ms,job_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [overlongJob.dispositionOperationSha256, overlongTenantId,
            overlongJob.requestId, overlongJob.scope, overlongJob.protocol,
            overlongJob.domain, overlongJob.targetSha256,
            overlongJob.artifactIdSha256, overlongJob.artifactGeneration,
            overlongJob.inventorySha256, overlongJob.writeOperationSha256,
            overlongJob.t3cReceiptSha256, overlongJob.t3dPlanReceiptSha256,
            overlongJob.t3dPlanEntryReceiptSha256, overlongJob.phase,
            overlongJob.attempts, overlongJob.blockedAtDbMs,
            overlongJob.blockedReasonCode, overlongJob.createdAtDbMs,
            overlongJob.updatedAtDbMs, JSON.stringify(overlongJob)],
        )).rejects.toThrow(/chk_tt_disposition_job|check constraint/i);
        f.phase("cold_connect");
        await expect(f.owner.openStore(4, scope.signal)).rejects.toThrow(/execution footprint exists/);
        f.phase("cold_connect_settled");
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; } finally {
        await f.close();
      }
    }));
  });
}
