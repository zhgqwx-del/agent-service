import { createHash, randomUUID } from "node:crypto";
import { emptyUsage, type Item, type Turn } from "@agent-service/protocol";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  EMPTY_USER_DATA_EXPORT_SNAPSHOT_ROOT_SHA256,
  MemoryBlobStore,
  MysqlSessionStore,
  SubjectDeletingError,
  USER_DATA_EXPORT_CONTENT_TYPE,
  UserDataExportStateError,
  canonicalUserDataExportBytes,
  newErasureRequestId,
  newUserDataExportArtifactId,
  newUserDataExportRequestId,
  nextUserDataExportSnapshotRootSha256,
  userDataExportAttachmentLogicalKey,
  userDataExportAuthorization,
  userDataExportIdempotencyKeySha256,
  userDataExportManifestSha256,
  userDataExportRequestHash,
  userDataExportStorageKey,
  userErasureRequestHash,
  tenantErasureRequestHash,
  type RequestUserDataExportInput,
  type UserDataExportAuthorization,
  type UserDataExportSnapshotSummary,
} from "../src/index.js";
import { UserDataExportWorker } from "../../core/src/index.js";
import { mkSession, newId } from "./conformance.js";
import { CaptureMysqlRuntimeOwner, type CaptureMysqlInspection } from "./fixtures/capture-mysql-runtime.js";
import { acquireFixtureSessionAuthority } from "./fixtures/session-authority.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
type Row = RowDataPacket;

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create user export fixture database from base database "${database}": `
      + "MYSQL_TEST_URL must name a test database",
    );
  }
  return url;
}

function exportInput(
  tenantId: string,
  userId: string,
  idempotencyKey: string,
  requestId = newUserDataExportRequestId(),
): RequestUserDataExportInput {
  return {
    requestId,
    tenantId,
    userId,
    requestedByKeyId: "export-admin",
    idempotencyKeySha256: userDataExportIdempotencyKeySha256(idempotencyKey),
    requestHash: userDataExportRequestHash(tenantId, userId),
  };
}

async function activatePolicy(store: MysqlSessionStore, tenantId: string): Promise<void> {
  const atMs = Date.now() - 60_000;
  const policyVersion = "export-policy-v1";
  await store.putRetentionPolicy({
    tenantId,
    policyVersion,
    policy: {
      sessionContentRetentionMs: null,
      userErasureGraceMs: null,
      operationalUsageRetentionMs: null,
      idempotencyReceiptRetentionMs: null,
      billingFactRetentionMs: null,
      lifecycleAuditRetentionMs: null,
      exportArtifactTtlMs: 10 * 60_000,
    },
    actorKeyId: "export-admin",
    atMs,
  });
  await store.activateRetentionPolicy({
    tenantId,
    policyVersion,
    expectedControlGeneration: 0,
    actorKeyId: "export-admin",
    atMs: atMs + 1,
  });
}

async function claimRequest(
  store: MysqlSessionStore,
  requestId: string,
  claimToken = `export-worker-${randomUUID()}`,
  leaseMs = 60_000,
): Promise<UserDataExportAuthorization> {
  const claims = await store.claimUserDataExports({ limit: 100, leaseMs, claimToken });
  const claim = claims.find((candidate) => candidate.requestId === requestId);
  if (!claim) throw new Error(`expected claim for ${requestId}`);
  return userDataExportAuthorization(claim);
}

async function publishArtifact(
  store: MysqlSessionStore,
  authorization: UserDataExportAuthorization,
  summary: UserDataExportSnapshotSummary,
) {
  const artifactId = newUserDataExportArtifactId();
  await store.startUserDataExportArtifact(authorization, {
    artifactId,
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    stagingTtlMs: 60_000,
  });
  const storageKey = userDataExportStorageKey(
    { tenantId: authorization.tenantId, userId: authorization.userId },
    authorization.requestId,
    artifactId,
    0,
  );
  await store.stageUserDataExportPart(authorization, {
    artifactId,
    partNumber: 0,
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    storageKey,
    uploadToken: `upload-${randomUUID()}`,
  });
  const bytes = Buffer.from(`export:${authorization.requestId}\n`, "utf8");
  const part = await store.markUserDataExportPartUploaded(authorization, {
    artifactId,
    partNumber: 0,
    descriptor: {
      storageKey,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      contentType: USER_DATA_EXPORT_CONTENT_TYPE,
    },
  });
  const ready = await store.completeUserDataExportArtifact(authorization, {
    artifactId,
    snapshotAtMs: summary.snapshotAtMs,
    partCount: 1,
    recordCount: summary.recordCount,
    totalSizeBytes: bytes.byteLength,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    manifestSha256: userDataExportManifestSha256([part]),
  });
  return { artifactId, part, ready };
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore user data export lifecycle", () => {
    let mysqlOwner: CaptureMysqlRuntimeOwner | undefined;
    let preparation: Promise<void> | undefined;
    let prepared = false;
    let suiteFailed = false;
    type Scope = { signal: AbortSignal; stores: Set<MysqlSessionStore>; inspections: Set<CaptureMysqlInspection>;
      failed: boolean; settled: boolean; detach: () => void; work?: Promise<void>;
      closing?: Promise<void>; cleanupReported?: boolean };
    const scopes = new Set<Scope>();
    let current: Scope | undefined;
    function scope(): Scope {
      if (!current) throw new Error("User export current case is not registered");
      return current;
    }
    function owner(): CaptureMysqlRuntimeOwner {
      if (!mysqlOwner || !prepared) throw new Error("User export current MySQL owner is not ready");
      return mysqlOwner;
    }
    function openStore(connectionLimit: number): Promise<MysqlSessionStore> {
      const value = scope(); value.signal.throwIfAborted();
      return owner().openStore(connectionLimit, value.signal).then(store => {
        value.stores.add(store); return store;
      });
    }
    function openInspection(): Promise<CaptureMysqlInspection> {
      const value = scope(); value.signal.throwIfAborted();
      return owner().openInspection(value.signal).then(conn => { value.inspections.add(conn); return conn; });
    }
    async function finish(value: Scope): Promise<void> {
      value.closing ??= (async () => {
        const closed = await Promise.allSettled([
          ...[...value.stores].map(store => store.close()),
          ...[...value.inspections].map(conn => conn.end()),
        ]);
        value.detach();
        const error = closed.find(result => result.status === "rejected");
        if (error?.status === "rejected") throw error.reason;
      })();
      try { await value.closing; }
      catch (reason) {
        suiteFailed = true;
        if (!value.failed) { value.failed = true; throw reason; }
        if (!value.cleanupReported) {
          value.cleanupReported = true;
          try { console.warn("user_export_fixture_cleanup_failed_after_primary_failure"); }
          catch { /* Preserve the original body failure. */ }
        }
      }
    }
    function runCase(body: () => Promise<void>) {
      return (): Promise<void> => {
        const value = scope();
        const work = Promise.resolve().then(async () => {
          try { value.signal.throwIfAborted(); await body(); value.signal.throwIfAborted(); }
          catch (reason) { value.failed = true; suiteFailed = true; throw reason; }
          finally { await finish(value); }
        });
        value.work = work;
        void work.then(() => { value.settled = true; }, () => { value.settled = true; });
        return work;
      };
    }
    beforeAll(async () => {
      const base = assertDisposableTestTarget(BASE_MYSQL_URL);
      mysqlOwner = new CaptureMysqlRuntimeOwner(base.toString(), {
        tenantTelemetryRefKey: null, tenantTelemetryPersistedProviderCaptureLocalOnly: false,
        tenantTelemetryCaptureRestoreLocalOnly: false,
      });
      // Keep the original one shared DB/bootstrap in beforeAll, including its original budget.
      preparation = mysqlOwner.prepare();
      try { await preparation; prepared = true; }
      catch (reason) { suiteFailed = true; throw reason; }
    });
    beforeEach(({ signal }) => {
      if ([...scopes].some(value => !value.settled)) throw new Error("User export prior case is not settled");
      const value: Scope = { signal, stores: new Set(), inspections: new Set(),
        failed: false, settled: false, detach: () => {} };
      const abort = () => {
        value.failed = true; suiteFailed = true;
        // Cancel original native DB work before any timeout hook joins the body.
        void mysqlOwner?.close({ successful: false }).catch(() => {});
      };
      value.signal.addEventListener("abort", abort, { once: true });
      value.detach = () => value.signal.removeEventListener("abort", abort);
      current = value; scopes.add(value); if (value.signal.aborted) abort();
    });
    afterEach(async () => {
      const value = scope();
      await Promise.allSettled(value.work ? [value.work] : []);
      await finish(value);
    });
    afterAll(async () => {
      // A timed-out original beforeAll can still own startup work. Cancel it before joining.
      let stopError: { reason: unknown } | undefined;
      if (!prepared) {
        suiteFailed = true;
        try { await mysqlOwner?.close({ successful: false }); }
        catch (reason) { stopError = { reason }; }
      }
      await Promise.allSettled(preparation ? [preparation] : []);
      await Promise.allSettled([...scopes].flatMap(value => value.work ? [value.work] : []));
      const closed = await Promise.allSettled([...scopes].map(value => finish(value)));
      const firstError = closed.find(result => result.status === "rejected");
      if (firstError) suiteFailed = true;
      let ownerError: { reason: unknown } | undefined;
      try { await mysqlOwner?.close({ successful: prepared && !suiteFailed }); }
      catch (reason) { ownerError = { reason }; }
      if (stopError) throw stopError.reason;
      if (firstError?.status === "rejected") throw firstError.reason;
      if (ownerError) throw ownerError.reason;
    });

    async function withSessionAuthority<T>(store: MysqlSessionStore,
      session: Parameters<typeof acquireFixtureSessionAuthority>[1], expectedFence: number,
      body: (lease: Awaited<ReturnType<typeof acquireFixtureSessionAuthority>>) => Promise<T>): Promise<T> {
      const lease = await acquireFixtureSessionAuthority(store, session, expectedFence);
      let outcome: { ok: true; value: T } | { ok: false; reason: unknown };
      try { outcome = { ok: true, value: await body(lease) }; }
      catch (reason) { outcome = { ok: false, reason }; }
      // Join exact release after the actual upload/bind work, retaining an original write error.
      try { await lease.release(); } catch (reason) { if (outcome.ok) outcome = { ok: false, reason }; }
      if (!outcome.ok) throw outcome.reason;
      return outcome.value;
    }

    it("rolls request and job creation back atomically and serializes idempotent races", runCase(async () => {
      const storeA = await openStore(4);
      const storeB = await openStore(4);
      const conn = await openInspection();
      const rollbackTenant = `tenant_export_rollback_${randomUUID()}`;
      const rollbackUser = `user_${randomUUID()}`;
      try {
        await activatePolicy(storeA, rollbackTenant);
        await conn.query(
          `CREATE TRIGGER user_export_job_insert_fail
             BEFORE INSERT ON user_export_jobs FOR EACH ROW
             SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected export job failure'`,
        );
        const rollbackInput = exportInput(rollbackTenant, rollbackUser, "rollback");
        await expect(storeA.requestUserDataExport(rollbackInput)).rejects.toThrow(
          "injected export job failure",
        );
        const [rolledBack] = await conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM user_export_requests WHERE request_id=?) AS request_count,
             (SELECT COUNT(*) FROM user_export_jobs WHERE request_id=?) AS job_count`,
          [rollbackInput.requestId, rollbackInput.requestId],
        );
        expect(Number(rolledBack[0]!.request_count)).toBe(0);
        expect(Number(rolledBack[0]!.job_count)).toBe(0);
        await conn.query("DROP TRIGGER user_export_job_insert_fail");

        const tenantId = `tenant_export_idem_${randomUUID()}`;
        const userId = `user_${randomUUID()}`;
        await activatePolicy(storeA, tenantId);
        const left = exportInput(tenantId, userId, "same-idempotency");
        const right = exportInput(tenantId, userId, "same-idempotency");
        const records = await Promise.all([
          storeA.requestUserDataExport(left),
          storeB.requestUserDataExport(right),
        ]);
        expect(records[0].requestId).toBe(records[1].requestId);
        expect([left.requestId, right.requestId]).toContain(records[0].requestId);
        const [counts] = await conn.query<Row[]>(
          `SELECT COUNT(*) AS row_count FROM user_export_requests
            WHERE tenant_id=? AND user_id=?`,
          [tenantId, userId],
        );
        expect(Number(counts[0]!.row_count)).toBe(1);
        const authorization = await claimRequest(storeA, records[0].requestId);
        expect(await storeA.retryUserDataExport(authorization, {
          delayMs: 0,
          errorCode: "temporary_failure",
          maxAttempts: 1,
        })).toBe(true);
      } finally {
        await conn.query("DROP TRIGGER IF EXISTS user_export_job_insert_fail");
        await conn.end();
        await storeB.close();
        await storeA.close();
      }
    }));

    it("quarantines a poison build candidate without starving a later valid claim", runCase(async () => {
      const store = await openStore(4);
      const conn = await openInspection();
      try {
        const requests: string[] = [];
        for (const suffix of ["poison", "valid"] as const) {
          const tenantId = `tenant_export_claim_${suffix}_${randomUUID()}`;
          const userId = `user_${randomUUID()}`;
          await activatePolicy(store, tenantId);
          const request = await store.requestUserDataExport(exportInput(tenantId, userId, suffix));
          requests.push(request.requestId);
        }
        await conn.query(
          "UPDATE user_export_requests SET requested_by_key_id='invalid actor' WHERE request_id=?",
          [requests[0]],
        );
        await conn.query(
          "UPDATE user_export_jobs SET available_at_ms=0 WHERE request_id=?",
          [requests[0]],
        );
        await conn.query(
          "UPDATE user_export_jobs SET available_at_ms=1 WHERE request_id=?",
          [requests[1]],
        );
        const claims = await store.claimUserDataExports({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `worker-${randomUUID()}`,
        });
        expect(claims.map((claim) => claim.requestId)).toEqual([requests[1]]);
        const [poisonRows] = await conn.query<Row[]>(
          `SELECT r.status AS request_status, r.last_error_code AS request_error,
                  j.status AS job_status, j.last_error_code AS job_error
             FROM user_export_requests r JOIN user_export_jobs j ON j.request_id=r.request_id
            WHERE r.request_id=?`,
          [requests[0]],
        );
        expect(poisonRows[0]).toMatchObject({
          request_status: "failed",
          request_error: "artifact_invalid",
          job_status: "failed",
          job_error: "artifact_invalid",
        });
        expect(await store.retryUserDataExport(userDataExportAuthorization(claims[0]!), {
          delayMs: 0,
          errorCode: "temporary_failure",
          maxAttempts: 1,
        })).toBe(true);
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("rolls poison quarantine back atomically, then deletes its exact sealed staging artifact", runCase(async () => {
      const store = await openStore(6);
      const conn = await openInspection();
      const poisonTenant = `tenant_export_claim_artifact_poison_${randomUUID()}`;
      const poisonUser = `user_${randomUUID()}`;
      try {
        await activatePolicy(store, poisonTenant);
        await store.createSession(mkSession(poisonTenant, poisonUser));
        const poisonRequest = await store.requestUserDataExport(
          exportInput(poisonTenant, poisonUser, "artifact-poison"),
        );
        const poisonAuthorization = await claimRequest(store, poisonRequest.requestId);
        await store.captureAndSealUserDataExportSnapshot(poisonAuthorization);
        const artifactId = newUserDataExportArtifactId();
        await store.startUserDataExportArtifact(poisonAuthorization, {
          artifactId,
          storageBackend: "memory-v1",
          storageFormat: BLOB_STORAGE_FORMAT,
          stagingTtlMs: 60_000,
        });
        const storageKey = userDataExportStorageKey(
          { tenantId: poisonTenant, userId: poisonUser },
          poisonRequest.requestId,
          artifactId,
          0,
        );
        await store.stageUserDataExportPart(poisonAuthorization, {
          artifactId,
          partNumber: 0,
          storageBackend: "memory-v1",
          storageFormat: BLOB_STORAGE_FORMAT,
          storageKey,
          uploadToken: `upload-${randomUUID()}`,
        });

        const validTenant = `tenant_export_claim_artifact_valid_${randomUUID()}`;
        const validUser = `user_${randomUUID()}`;
        await activatePolicy(store, validTenant);
        await store.createSession(mkSession(validTenant, validUser));
        const validRequest = await store.requestUserDataExport(
          exportInput(validTenant, validUser, "artifact-valid"),
        );
        // Keep the poison build leased while preparing a second, independently safe cleanup
        // candidate. The claim helper therefore cannot accidentally take over the poison row.
        const validAuthorization = await claimRequest(store, validRequest.requestId);
        await store.captureAndSealUserDataExportSnapshot(validAuthorization);
        const validArtifactId = newUserDataExportArtifactId();
        await store.startUserDataExportArtifact(validAuthorization, {
          artifactId: validArtifactId,
          storageBackend: "memory-v1",
          storageFormat: BLOB_STORAGE_FORMAT,
          stagingTtlMs: 60_000,
        });
        const validStorageKey = userDataExportStorageKey(
          { tenantId: validTenant, userId: validUser },
          validRequest.requestId,
          validArtifactId,
          0,
        );
        await store.stageUserDataExportPart(validAuthorization, {
          artifactId: validArtifactId,
          partNumber: 0,
          storageBackend: "memory-v1",
          storageFormat: BLOB_STORAGE_FORMAT,
          storageKey: validStorageKey,
          uploadToken: `upload-${randomUUID()}`,
        });
        expect(await store.retryUserDataExport(validAuthorization, {
          delayMs: 0,
          errorCode: "temporary_failure",
        })).toBe(true);
        expect(await store.retryUserDataExport(poisonAuthorization, {
          delayMs: 0,
          errorCode: "temporary_failure",
        })).toBe(true);
        await conn.query(
          "UPDATE user_export_requests SET requested_by_key_id='invalid actor' WHERE request_id=?",
          [poisonRequest.requestId],
        );
        await conn.query(
          "UPDATE user_export_jobs SET available_at_ms=0 WHERE request_id=?",
          [poisonRequest.requestId],
        );
        await conn.query(
          "UPDATE user_export_jobs SET available_at_ms=1 WHERE request_id=?",
          [validRequest.requestId],
        );

        await conn.query(
          `CREATE TRIGGER user_export_quarantine_update_fail
             BEFORE UPDATE ON user_export_requests FOR EACH ROW
             SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected export quarantine failure'`,
        );
        await expect(store.claimUserDataExports({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `worker-${randomUUID()}`,
        })).rejects.toThrow("injected export quarantine failure");
        const [rolledBackRows] = await conn.query<Row[]>(
          `SELECT r.status AS request_status, j.status AS job_status,
                  a.state AS artifact_state, p.state AS part_state,
                  (SELECT COUNT(*) FROM user_export_artifact_delete_outbox
                    WHERE artifact_id=?) AS outbox_count,
                  (SELECT COUNT(*) FROM user_export_snapshot_records
                    WHERE request_id=?) AS snapshot_count
             FROM user_export_requests r
             JOIN user_export_jobs j ON j.request_id=r.request_id
             JOIN user_export_artifacts a ON a.artifact_id=r.active_artifact_id
             JOIN user_export_artifact_parts p ON p.artifact_id=a.artifact_id
            WHERE r.request_id=?`,
          [artifactId, poisonRequest.requestId, poisonRequest.requestId],
        );
        expect(rolledBackRows[0]).toMatchObject({
          request_status: "queued",
          job_status: "queued",
          artifact_state: "staging",
          part_state: "staging",
          outbox_count: 0,
        });
        expect(Number(rolledBackRows[0]!.snapshot_count)).toBeGreaterThan(0);
        await conn.query("DROP TRIGGER user_export_quarantine_update_fail");

        // Both artifacts are now cleanup candidates. Parsing the poison request must fail closed
        // for that exact row without aborting the bounded pass or starving the safe neighbor.
        await conn.query(
          "UPDATE user_export_artifacts SET staging_expires_at_ms=0 WHERE artifact_id IN (?,?)",
          [artifactId, validArtifactId],
        );
        expect(await store.scheduleUserDataExportDeletes(10)).toBe(1);
        const [safeNeighborRows] = await conn.query<Row[]>(
          `SELECT r.status AS request_status, a.state AS artifact_state,
                  p.state AS part_state,
                  (SELECT COUNT(*) FROM user_export_artifact_delete_outbox
                    WHERE artifact_id=?) AS outbox_count
             FROM user_export_requests r
             JOIN user_export_artifacts a ON a.artifact_id=r.active_artifact_id
             JOIN user_export_artifact_parts p ON p.artifact_id=a.artifact_id
            WHERE r.request_id=?`,
          [validArtifactId, validRequest.requestId],
        );
        expect(safeNeighborRows[0]).toMatchObject({
          request_status: "failed",
          artifact_state: "delete_pending",
          part_state: "delete_pending",
          outbox_count: 1,
        });

        const claims = await store.claimUserDataExports({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `worker-${randomUUID()}`,
        });
        expect(claims).toEqual([]);
        const [quarantinedRows] = await conn.query<Row[]>(
          `SELECT r.status AS request_status, j.status AS job_status,
                  a.state AS artifact_state, p.state AS part_state,
                  (SELECT COUNT(*) FROM user_export_artifact_delete_outbox
                    WHERE artifact_id=?) AS outbox_count,
                  (SELECT COUNT(*) FROM user_export_snapshot_records
                    WHERE request_id=?) AS snapshot_count
             FROM user_export_requests r
             JOIN user_export_jobs j ON j.request_id=r.request_id
             JOIN user_export_artifacts a ON a.artifact_id=r.active_artifact_id
             JOIN user_export_artifact_parts p ON p.artifact_id=a.artifact_id
            WHERE r.request_id=?`,
          [artifactId, poisonRequest.requestId, poisonRequest.requestId],
        );
        expect(quarantinedRows[0]).toMatchObject({
          request_status: "failed",
          job_status: "failed",
          artifact_state: "delete_pending",
          part_state: "delete_pending",
          outbox_count: 1,
          snapshot_count: 0,
        });
        const deleteClaims = await store.claimUserDataExportDeletes({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `delete-${randomUUID()}`,
        });
        const deleteClaim = deleteClaims.find((candidate) => candidate.artifactId === artifactId);
        expect(deleteClaim).toMatchObject({ storageKey, partNumber: 0, deletionGeneration: 1 });
        expect(await store.completeUserDataExportDelete(
          deleteClaim!.outboxId,
          deleteClaim!.claimToken!,
        )).toBe(true);
      } finally {
        await conn.query("DROP TRIGGER IF EXISTS user_export_quarantine_update_fail");
        await conn.end();
        await store.close();
      }
    }));

    it("rolls partial snapshots back and seals one RR snapshot under concurrent retry", runCase(async () => {
      const store = await openStore(6);
      const conn = await openInspection();
      const tenantId = `tenant_export_snapshot_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        await activatePolicy(store, tenantId);
        await store.createSession(mkSession(tenantId, userId));
        const request = await store.requestUserDataExport(exportInput(tenantId, userId, "snapshot"));
        const authorization = await claimRequest(store, request.requestId);
        await conn.query(
          `CREATE TRIGGER user_export_snapshot_insert_fail
             BEFORE INSERT ON user_export_snapshot_records FOR EACH ROW
             SET NEW.ordinal=IF(NEW.ordinal=1,-1,NEW.ordinal)`,
        );
        await expect(store.captureAndSealUserDataExportSnapshot(authorization)).rejects.toThrow();
        const [rolledBack] = await conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM user_export_snapshot_records WHERE request_id=?) AS record_count,
             (SELECT snapshot_sealed_at_ms FROM user_export_jobs WHERE request_id=?) AS sealed_at,
             (SELECT snapshot_at_ms FROM user_export_requests WHERE request_id=?) AS snapshot_at`,
          [request.requestId, request.requestId, request.requestId],
        );
        expect(Number(rolledBack[0]!.record_count)).toBe(0);
        expect(rolledBack[0]!.sealed_at).toBeNull();
        expect(rolledBack[0]!.snapshot_at).toBeNull();
        await conn.query("DROP TRIGGER user_export_snapshot_insert_fail");

        const [first, second] = await Promise.all([
          store.captureAndSealUserDataExportSnapshot(authorization),
          store.captureAndSealUserDataExportSnapshot(authorization),
        ]);
        expect(second).toEqual(first);
        expect(first.counts).toMatchObject({ session: 1, event: 1, attachment: 0 });
        const page1 = await store.readUserDataExportSnapshotRecords(authorization, { limit: 1 });
        const page2 = await store.readUserDataExportSnapshotRecords(authorization, {
          afterOrdinal: page1.nextOrdinal!,
          limit: 10,
        });
        expect([...page1.data, ...page2.data].map((record) => record.ordinal)).toEqual([0, 1]);
        expect(await store.getUserDataExport("other-tenant", userId, request.requestId)).toBeNull();
        expect(await store.retryUserDataExport(authorization, {
          delayMs: 0,
          errorCode: "snapshot_invalid",
          maxAttempts: 1,
        })).toBe(true);
      } finally {
        await conn.query("DROP TRIGGER IF EXISTS user_export_snapshot_insert_fail");
        await conn.end();
        await store.close();
      }
    }));

    it("pins ready attachments and hashes their canonical public records into the snapshot root", runCase(async () => {
      const store = await openStore(4);
      const tenantId = `tenant_export_attachment_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        await activatePolicy(store, tenantId);
        const storageNamespaceSha256 = "b".repeat(64);
        await store.activateBlobStorageControl({
          expectedControlGeneration: 0,
          storageBackend: "memory-v1",
          namespaceSha256: storageNamespaceSha256,
        });
        const session = mkSession(tenantId, userId);
        await store.createSession(session);
        const now = Date.now();
        const turn: Turn = {
          id: newId("turn"),
          sessionId: session.id,
          status: "inProgress",
          seqStart: 2,
          steps: 1,
          toolCalls: 1,
          usage: emptyUsage(),
          startedAtMs: now,
          idempotencyKey: "must-not-leave-the-service",
        };
        const blobId = newId("blob");
        const storageKey = `objects/${blobId.slice("blob_".length)}`;
        const uploadToken = `upload-${blobId.slice("blob_".length)}`;
        await withSessionAuthority(store, session, 0, async lease => {
          await store.stageBlob(lease.admit<Parameters<MysqlSessionStore["stageBlob"]>[0]>({
            owner: { tenantId, userId },
            sessionId: session.id,
            fence: 1,
            blobId,
            purpose: "tool_output",
            storageBackend: "memory-v1",
            storageFormat: BLOB_STORAGE_FORMAT,
            storageKey,
            uploadToken,
            createdAtMs: now,
            stagingExpiresAtMs: now + 60_000,
          }));
          await store.markBlobUploaded(lease.admit<Parameters<MysqlSessionStore["markBlobUploaded"]>[0]>({
            owner: { tenantId, userId },
            sessionId: session.id,
            fence: 1,
            blobId,
            uploadToken,
            sha256: "a".repeat(64),
            sizeBytes: 128,
            contentType: "application/json",
            uploadedAtMs: now + 1,
          }));
        });
        const item: Item = {
          id: newId("item"),
          sessionId: session.id,
          turnId: turn.id,
          seq: 3,
          step: 1,
          status: "completed",
          createdAtMs: now + 2,
          completedAtMs: now + 3,
          type: "toolResult",
          toolCallId: "call-export-attachment",
          name: "large_output",
          content: [],
          isError: false,
          outputRef: blobId,
        };
        await withSessionAuthority(store, session, 1, async lease => {
          await store.commit(lease.admit<Parameters<MysqlSessionStore["commit"]>[0]>({
            sessionId: session.id,
            fence: 2,
            turn,
            items: [item],
            blobBindings: [{ blobId, itemId: item.id, purpose: "tool_output" }],
            events: [
              { type: "turn/started", sessionId: session.id, emittedAtMs: now + 2, turn },
              { type: "item/completed", sessionId: session.id, emittedAtMs: now + 3, item },
            ],
          }));
        });
        const request = await store.requestUserDataExport(exportInput(tenantId, userId, "attachment"));
        const authorization = await claimRequest(store, request.requestId);
        const summary = await store.captureAndSealUserDataExportSnapshot(authorization);
        const records = (await store.readUserDataExportSnapshotRecords(
          authorization,
          { limit: 100 },
        )).data;
        const blobs = (await store.readUserDataExportSnapshotBlobs(
          authorization,
          { limit: 100 },
        )).data;
        expect(blobs).toHaveLength(1);
        expect(summary.counts.attachment).toBe(1);
        const blob = blobs[0]!;
        expect(blob.storageNamespaceSha256).toBe(storageNamespaceSha256);
        const publicAttachment = {
          blobId: blob.blobId,
          sessionId: blob.sessionId,
          itemId: blob.itemId,
          purpose: blob.purpose,
          contentType: blob.contentType,
          sha256: blob.sha256,
          sizeBytes: blob.sizeBytes,
        };
        const attachmentBytes = canonicalUserDataExportBytes({
          type: "attachment",
          value: publicAttachment,
        });
        let root = EMPTY_USER_DATA_EXPORT_SNAPSHOT_ROOT_SHA256;
        for (const record of records) {
          root = nextUserDataExportSnapshotRootSha256(
            root,
            record.kind,
            record.logicalKey,
            record.sha256,
            record.sizeBytes,
          );
        }
        root = nextUserDataExportSnapshotRootSha256(
          root,
          "attachment",
          userDataExportAttachmentLogicalKey(publicAttachment),
          createHash("sha256").update(attachmentBytes).digest("hex"),
          attachmentBytes.byteLength,
        );
        expect(root).toBe(summary.snapshotRootSha256);
        expect(Buffer.from(records.find((record) => record.kind === "turn")!.canonicalBytes)
          .toString("utf8")).not.toContain("must-not-leave-the-service");
        expect(await store.retryUserDataExport(authorization, {
          delayMs: 0,
          errorCode: "temporary_failure",
          maxAttempts: 1,
        })).toBe(true);
      } finally {
        await store.close();
      }
    }));

    it("runs the real export worker from MySQL snapshot through BlobStore publication to ready", runCase(async () => {
      const store = await openStore(6);
      const conn = await openInspection();
      const tenantId = `tenant_export_worker_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        await activatePolicy(store, tenantId);
        await store.createSession(mkSession(tenantId, userId));
        const request = await store.requestUserDataExport(exportInput(tenantId, userId, "worker"));
        const blob = new MemoryBlobStore();
        const worker = new UserDataExportWorker({
          store,
          blob,
          logger: { warn: () => {}, error: () => {} },
        }, {
          partMaxBytes: 5_000,
          attachmentChunkBytes: 256,
          snapshotPageSize: 1,
          retryBaseMs: 1,
          retryMaxMs: 1,
        });
        expect(await worker.processOnce()).toBe(1);
        await expect(store.getUserDataExport(tenantId, userId, request.requestId))
          .resolves.toMatchObject({ status: "ready", currentArtifactId: expect.any(String) });
        const [partRows] = await conn.query<Row[]>(
          `SELECT state, content_type, sha256, size_bytes FROM user_export_artifact_parts
            WHERE request_id=?`,
          [request.requestId],
        );
        expect(partRows).toHaveLength(1);
        expect(partRows[0]).toMatchObject({
          state: "uploaded",
          content_type: USER_DATA_EXPORT_CONTENT_TYPE,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        expect(Number(partRows[0]!.size_bytes)).toBeGreaterThan(0);
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("fences claim ABA and can seal after its lease elapses while holding the job lock", runCase(async () => {
      const store = await openStore(4);
      const conn = await openInspection();
      const tenantId = `tenant_export_aba_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      const claimToken = `worker-reused-${randomUUID()}`;
      try {
        await activatePolicy(store, tenantId);
        await store.createSession(mkSession(tenantId, userId));
        const request = await store.requestUserDataExport(exportInput(tenantId, userId, "aba"));
        const first = await claimRequest(store, request.requestId, claimToken);
        await conn.query(
          "UPDATE user_export_jobs SET lease_until_ms=0 WHERE request_id=?",
          [request.requestId],
        );
        const second = await claimRequest(store, request.requestId, claimToken, 500);
        expect(second).toMatchObject({ buildGeneration: 2, claimAttempt: 2, claimToken });
        await expect(store.captureAndSealUserDataExportSnapshot(first))
          .rejects.toBeInstanceOf(UserDataExportStateError);
        await conn.query(
          `CREATE TRIGGER user_export_snapshot_insert_delay
             BEFORE INSERT ON user_export_snapshot_records FOR EACH ROW DO SLEEP(0.3)`,
        );
        const summary = await store.captureAndSealUserDataExportSnapshot(second);
        expect(summary.recordCount).toBe(2);
        await conn.query("DROP TRIGGER user_export_snapshot_insert_delay");
        const third = await claimRequest(store, request.requestId, claimToken, 60_000);
        expect(third).toMatchObject({ buildGeneration: 2, claimAttempt: 3, claimToken });
        await expect(store.captureAndSealUserDataExportSnapshot(third)).resolves.toEqual(summary);
        expect(await store.retryUserDataExport(third, {
          delayMs: 0,
          errorCode: "temporary_failure",
          maxAttempts: 3,
        })).toBe(true);
      } finally {
        await conn.query("DROP TRIGGER IF EXISTS user_export_snapshot_insert_delay");
        await conn.end();
        await store.close();
      }
    }));

    it("serializes export admission against user erasure and leaves no live export", runCase(async () => {
      const exportStore = await openStore(4);
      const erasureStore = await openStore(4);
      const conn = await openInspection();
      const tenantId = `tenant_export_erasure_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      const input = exportInput(tenantId, userId, "erasure-race");
      try {
        await activatePolicy(exportStore, tenantId);
        const [exportResult, erasureResult] = await Promise.allSettled([
          exportStore.requestUserDataExport(input),
          erasureStore.requestUserErasure({
            requestId: newErasureRequestId(),
            tenantId,
            userId,
            requestedByKeyId: "export-admin",
            idempotencyKey: `erase-${randomUUID()}`,
            requestHash: userErasureRequestHash(tenantId, userId),
            atMs: Date.now(),
          }),
        ]);
        expect(erasureResult.status).toBe("fulfilled");
        if (exportResult.status === "rejected") {
          expect(exportResult.reason).toBeInstanceOf(SubjectDeletingError);
        } else {
          await expect(exportStore.getUserDataExport(tenantId, userId, input.requestId))
            .resolves.toMatchObject({ status: "revoked" });
        }
        const [rows] = await conn.query<Row[]>(
          `SELECT COUNT(*) AS live_count FROM user_export_requests
            WHERE tenant_id=? AND user_id=? AND status<>'revoked'`,
          [tenantId, userId],
        );
        expect(Number(rows[0]!.live_count)).toBe(0);
      } finally {
        await conn.end();
        await erasureStore.close();
        await exportStore.close();
      }
    }));

    it("blocks export on orphan tenant admission evidence without affecting a neighbor", runCase(async () => {
      const store = await openStore(4);
      const conn = await openInspection();
      const tenantId = `tenant_export_orphan_admission_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      const neighborId = `tenant_export_orphan_neighbor_${randomUUID()}`;
      const neighborUserId = `user_${randomUUID()}`;
      const tenantRequestId = newErasureRequestId();
      const atMs = Date.now();
      try {
        await activatePolicy(store, tenantId);
        await activatePolicy(store, neighborId);
        await store.createSession(mkSession(tenantId, userId));
        await store.createSession(mkSession(neighborId, neighborUserId));
        const existing = await store.requestUserDataExport(exportInput(
          tenantId,
          userId,
          "existing-before-orphan",
        ));
        await conn.query(
          `INSERT INTO tenant_erasure_admissions
             (request_id, tenant_id, subject_generation, requested_by_key_id,
              idempotency_key, request_hash, created_at_ms, gated_at_ms, updated_at_ms,
              policy_version, policy_hash, control_generation)
           VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,0)`,
          [
            tenantRequestId,
            tenantId,
            1,
            "platform-lifecycle-admin",
            `orphan-${randomUUID()}`,
            tenantErasureRequestHash(tenantId),
            atMs,
            atMs,
            atMs,
          ],
        );

        await expect(store.requestUserDataExport(exportInput(tenantId, userId, "blocked")))
          .rejects.toBeInstanceOf(SubjectDeletingError);
        await expect(store.getUserDataExport(tenantId, userId, existing.requestId))
          .resolves.toMatchObject({ status: "revoked" });
        await expect(store.requestUserDataExport(exportInput(
          neighborId,
          neighborUserId,
          "neighbor-allowed",
        ))).resolves.toMatchObject({
          tenantId: neighborId,
          userId: neighborUserId,
          status: "queued",
        });
        const [rows] = await conn.query<Row[]>(
          `SELECT COUNT(*) AS request_count,
                  SUM(status<>'revoked') AS live_count
             FROM user_export_requests WHERE tenant_id=?`,
          [tenantId],
        );
        expect({
          requestCount: Number(rows[0]!.request_count),
          liveCount: Number(rows[0]!.live_count),
        }).toEqual({ requestCount: 1, liveCount: 0 });
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("expires admission but preserves active download leases before exact delete cleanup", runCase(async () => {
      const store = await openStore(6);
      const conn = await openInspection();
      const tenantId = `tenant_export_ttl_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        await activatePolicy(store, tenantId);
        await store.createSession(mkSession(tenantId, userId));
        const request = await store.requestUserDataExport(exportInput(tenantId, userId, "ttl"));
        const authorization = await claimRequest(store, request.requestId);
        const summary = await store.captureAndSealUserDataExportSnapshot(authorization);
        const published = await publishArtifact(store, authorization, summary);
        const leaseToken = `download-${randomUUID()}`;
        await expect(store.acquireUserDataExportDownload(
          tenantId,
          userId,
          request.requestId,
          leaseToken,
          60_000,
        )).resolves.toMatchObject({ leaseToken });
        await expect(store.acquireUserDataExportDownload(
          tenantId,
          "other-user",
          request.requestId,
          `download-${randomUUID()}`,
          60_000,
        )).resolves.toBeNull();
        const [leaseBeforeRows] = await conn.query<Row[]>(
          `SELECT lease_until_ms FROM user_export_download_leases
            WHERE artifact_id=? AND lease_token=?`,
          [published.artifactId, leaseToken],
        );
        expect(await store.renewUserDataExportDownload(
          published.artifactId,
          leaseToken,
          1,
        )).toBe(true);
        const [leaseAfterRows] = await conn.query<Row[]>(
          `SELECT lease_until_ms FROM user_export_download_leases
            WHERE artifact_id=? AND lease_token=?`,
          [published.artifactId, leaseToken],
        );
        expect(Number(leaseAfterRows[0]!.lease_until_ms))
          .toBeGreaterThanOrEqual(Number(leaseBeforeRows[0]!.lease_until_ms));
        await conn.query(
          "UPDATE user_export_requests SET ready_at_ms=0, expires_at_ms=1 WHERE request_id=?",
          [request.requestId],
        );
        await conn.query(
          "UPDATE user_export_artifacts SET ready_at_ms=0, expires_at_ms=1 WHERE artifact_id=?",
          [published.artifactId],
        );
        const [expired, scheduledWhileLeased] = await Promise.all([
          store.getUserDataExport(tenantId, userId, request.requestId),
          store.scheduleUserDataExportDeletes(10),
        ]);
        expect(expired).toMatchObject({ status: "expired" });
        expect(scheduledWhileLeased).toBe(0);
        expect(await store.renewUserDataExportDownload(published.artifactId, leaseToken, 60_000))
          .toBe(true);
        expect(await store.scheduleUserDataExportDeletes(10)).toBe(0);
        await store.releaseUserDataExportDownload(published.artifactId, leaseToken);
        expect(await store.scheduleUserDataExportDeletes(10)).toBe(1);
        const claimed = await store.claimUserDataExportDeletes({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `delete-${randomUUID()}`,
        });
        expect(claimed).toHaveLength(1);
        expect(claimed[0]).toMatchObject({
          artifactId: published.artifactId,
          requestId: request.requestId,
          partNumber: 0,
          deletionGeneration: 1,
          storageKey: published.part.storageKey,
          uploadToken: published.part.uploadToken,
        });
        expect(await store.completeUserDataExportDelete(claimed[0]!.outboxId, "wrong-token"))
          .toBe(false);
        expect(await store.completeUserDataExportDelete(
          claimed[0]!.outboxId,
          claimed[0]!.claimToken!,
        )).toBe(true);
        const [artifactRows] = await conn.query<Row[]>(
          "SELECT state FROM user_export_artifacts WHERE artifact_id=?",
          [published.artifactId],
        );
        expect(artifactRows[0]!.state).toBe("deleted");
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("treats staging TTL as an orphan cutoff while the exact build claim remains active", runCase(async () => {
      const store = await openStore(6);
      const conn = await openInspection();
      const tenantId = `tenant_export_staging_cutoff_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      try {
        await activatePolicy(store, tenantId);
        await store.createSession(mkSession(tenantId, userId));
        const request = await store.requestUserDataExport(exportInput(
          tenantId,
          userId,
          "staging-cutoff",
        ));
        const authorization = await claimRequest(store, request.requestId);
        const summary = await store.captureAndSealUserDataExportSnapshot(authorization);
        const artifactId = newUserDataExportArtifactId();
        const artifact = await store.startUserDataExportArtifact(authorization, {
          artifactId,
          storageBackend: "memory-v1",
          storageFormat: BLOB_STORAGE_FORMAT,
          stagingTtlMs: 60_000,
        });
        await conn.query(
          "UPDATE user_export_artifacts SET staging_expires_at_ms=0 WHERE artifact_id=?",
          [artifactId],
        );
        expect(await store.scheduleUserDataExportDeletes(10)).toBe(0);

        const storageKey = userDataExportStorageKey(
          { tenantId, userId },
          request.requestId,
          artifactId,
          0,
        );
        await store.stageUserDataExportPart(authorization, {
          artifactId,
          partNumber: 0,
          storageBackend: artifact.storageBackend,
          storageFormat: artifact.storageFormat,
          storageKey,
          uploadToken: `upload-${randomUUID()}`,
        });
        const bytes = Buffer.from("active mysql build survives its orphan cutoff", "utf8");
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const part = await store.markUserDataExportPartUploaded(authorization, {
          artifactId,
          partNumber: 0,
          descriptor: {
            storageKey,
            sha256,
            sizeBytes: bytes.byteLength,
            contentType: USER_DATA_EXPORT_CONTENT_TYPE,
          },
        });
        await expect(store.completeUserDataExportArtifact(authorization, {
          artifactId,
          snapshotAtMs: summary.snapshotAtMs,
          partCount: 1,
          recordCount: summary.recordCount,
          totalSizeBytes: bytes.byteLength,
          contentSha256: sha256,
          manifestSha256: userDataExportManifestSha256([part]),
        })).resolves.toMatchObject({ status: "ready" });
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("dead-letters a corrupt delete identity without starving the next valid intent", runCase(async () => {
      const store = await openStore(6);
      const conn = await openInspection();
      const artifacts: { artifactId: string; requestId: string }[] = [];
      try {
        for (const suffix of ["poison", "valid"] as const) {
          const tenantId = `tenant_export_delete_${suffix}_${randomUUID()}`;
          const userId = `user_${randomUUID()}`;
          await activatePolicy(store, tenantId);
          await store.createSession(mkSession(tenantId, userId));
          const request = await store.requestUserDataExport(exportInput(tenantId, userId, suffix));
          const authorization = await claimRequest(store, request.requestId);
          const summary = await store.captureAndSealUserDataExportSnapshot(authorization);
          const published = await publishArtifact(store, authorization, summary);
          artifacts.push({ artifactId: published.artifactId, requestId: request.requestId });
          await conn.query(
            "UPDATE user_export_requests SET status='expired', ready_at_ms=0, expires_at_ms=1 WHERE request_id=?",
            [request.requestId],
          );
          await conn.query(
            "UPDATE user_export_artifacts SET ready_at_ms=0, expires_at_ms=1 WHERE artifact_id=?",
            [published.artifactId],
          );
        }
        expect(await store.scheduleUserDataExportDeletes(10)).toBe(2);
        const [outboxRows] = await conn.query<Row[]>(
          `SELECT outbox_id, artifact_id FROM user_export_artifact_delete_outbox
            WHERE artifact_id IN (?,?) ORDER BY outbox_id`,
          [artifacts[0]!.artifactId, artifacts[1]!.artifactId],
        );
        expect(outboxRows).toHaveLength(2);
        await conn.query(
          "UPDATE user_export_artifact_delete_outbox SET expected_sha256=? WHERE outbox_id=?",
          ["f".repeat(64), outboxRows[0]!.outbox_id],
        );
        const claimed = await store.claimUserDataExportDeletes({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `delete-${randomUUID()}`,
        });
        expect(claimed).toHaveLength(1);
        expect(claimed[0]!.artifactId).toBe(String(outboxRows[1]!.artifact_id));
        const [poisonRows] = await conn.query<Row[]>(
          `SELECT dead_lettered_at_ms, last_error FROM user_export_artifact_delete_outbox
            WHERE outbox_id=?`,
          [outboxRows[0]!.outbox_id],
        );
        expect(poisonRows[0]!.dead_lettered_at_ms).not.toBeNull();
        expect(poisonRows[0]!.last_error).toBe("delete_intent_identity_invalid");
        expect(await store.completeUserDataExportDelete(
          claimed[0]!.outboxId,
          claimed[0]!.claimToken!,
        )).toBe(true);
      } finally {
        await conn.end();
        await store.close();
      }
    }));
  });
}
