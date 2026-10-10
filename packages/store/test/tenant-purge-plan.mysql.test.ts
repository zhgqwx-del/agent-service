import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  emptyUsage,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type Item,
  type TenantRuntimeRevocationFleetProof,
  type Turn,
} from "@agent-service/protocol";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  MysqlSessionStore,
  TENANT_PURGE_PLAN_DOMAINS,
  TenantErasureIntegrityError,
  TenantPurgePlanEvidenceChangedError,
  USER_DATA_EXPORT_CONTENT_TYPE,
  legalHoldControlSha256,
  legalHoldProjectionSha256,
  legacyTombstoneCompensationJobIdForSession,
  legacyTombstoneSuccessEvidenceSha256,
  newErasureRequestId,
  newUserDataExportArtifactId,
  newUserDataExportRequestId,
  tenantErasureRequestHash,
  userErasureRequestHash,
  userDataExportAuthorization,
  userDataExportIdempotencyKeySha256,
  userDataExportManifestSha256,
  userDataExportRequestHash,
  userDataExportStorageKey,
  type LegalHoldControlRecord,
  type LegalHoldRecord,
  type RetentionPolicyDocumentV1,
  type TenantContentInventoryAuthorization,
  type TenantCredentialRevocationAuthorization,
  type TenantPurgePlanAuthorization,
  type TenantRuntimeRevocationAuthorization,
  type TenantRuntimeRevocationClaim,
  type UserDataExportAuthorization,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(`MYSQL_TEST_URL must name a disposable test database, got ${database}`);
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function legacyTombstoneCandidateSha256(input: {
  sessionId: string;
  tenantId: string;
  userId: string;
  deletedAtMs: number;
  lastSeq: number;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "legacy-tombstone-candidate-v1",
    input.sessionId,
    input.tenantId,
    input.userId,
    input.deletedAtMs,
    input.lastSeq,
  ])).digest("hex");
}

function policy(contentRetentionMs: number): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: contentRetentionMs,
    userErasureGraceMs: 0,
    operationalUsageRetentionMs: 0,
    idempotencyReceiptRetentionMs: 0,
    billingFactRetentionMs: 0,
    lifecycleAuditRetentionMs: 0,
    exportArtifactTtlMs: 60_000,
  };
}

function credentialAuthorization(
  claim: Awaited<ReturnType<MysqlSessionStore["claimTenantCredentialRevocations"]>>[number],
): TenantCredentialRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function runtimeAuthorization(
  claim: TenantRuntimeRevocationClaim,
): TenantRuntimeRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function contentAuthorization(
  claim: Awaited<ReturnType<MysqlSessionStore["claimTenantContentInventories"]>>[number],
): TenantContentInventoryAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    buildGeneration: claim.buildGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function planAuthorization(
  claim: Awaited<ReturnType<MysqlSessionStore["claimTenantPurgePlans"]>>[number],
): TenantPurgePlanAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    buildGeneration: claim.buildGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function fleetProof(claim: TenantRuntimeRevocationClaim): TenantRuntimeRevocationFleetProof {
  const body = {
    targetSha256: tenantRuntimeTargetSha256("http://mysql-purge-runner.internal:8080"),
    runnerId: "mysql-purge-runner",
    bootId: "mysql-purge-boot",
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    t3aReceiptSha256: claim.t3aReceiptSha256,
    cacheEntryCountBefore: 1,
    cacheEntryCountAfter: 0 as const,
    activeOperationCountBefore: 1,
    activeOperationCountAfter: 0 as const,
    activeTurnCountBefore: 1,
    activeTurnCountAfter: 0 as const,
    completedAtMs: Date.now(),
  };
  const targets = [{ ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) }];
  return {
    fleetSha256: tenantRuntimeFleetSha256(targets),
    targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets),
    targets,
  };
}

async function installPolicy(
  store: MysqlSessionStore,
  tenantId: string,
  contentRetentionMs = 0,
): Promise<void> {
  const atMs = Date.now();
  await store.putRetentionPolicy({
    tenantId,
    policyVersion: "policy-v1",
    policy: policy(contentRetentionMs),
    actorKeyId: "policy-admin",
    atMs,
  });
  await store.activateRetentionPolicy({
    tenantId,
    policyVersion: "policy-v1",
    expectedControlGeneration: 0,
    actorKeyId: "policy-admin",
    atMs: atMs + 1,
  });
}

async function databaseNow(conn: Connection): Promise<number> {
  const [rows] = await conn.query<(RowDataPacket & { now_ms: number })[]>(
    "SELECT CAST(ROUND(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS UNSIGNED) AS now_ms",
  );
  return Number(rows[0]?.now_ms);
}

async function waitForIdempotencyLockWait(
  observer: Connection,
  database: string,
  writerConnectionId: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [rows] = await observer.query<(RowDataPacket & { waiters: number })[]>(
      `SELECT COUNT(DISTINCT waits.REQUESTING_ENGINE_TRANSACTION_ID) AS waiters
         FROM performance_schema.data_lock_waits waits
         JOIN performance_schema.data_locks requested
           ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
         JOIN performance_schema.threads threads
           ON threads.THREAD_ID=requested.THREAD_ID
        WHERE requested.OBJECT_SCHEMA=?
          AND requested.OBJECT_NAME='idempotency_keys'
          AND threads.PROCESSLIST_ID=?`,
      [database, writerConnectionId],
    );
    if (Number(rows[0]?.waiters ?? 0) > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `timed out waiting for idempotency lock held against writer ${writerConnectionId}`,
  );
}

const LEGACY_EVENT_UPDATE_GUARDS = [
  "trg_legacy_tombstone_compensation_events_bu",
  "trg_legacy_tombstone_compensation_events_bu_guard_a",
  "trg_legacy_tombstone_compensation_events_bu_guard_b",
] as const;

async function injectLegacyEventCorruption(
  conn: Connection,
  update: () => Promise<void>,
): Promise<void> {
  // The production table is append-only. A disposable fixture must briefly remove every update
  // guard to simulate on-disk corruption, then restore the exact guards before the store observes
  // the row. This never weakens the transaction under test.
  for (const trigger of LEGACY_EVENT_UPDATE_GUARDS) {
    await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``);
  }
  try {
    await update();
  } finally {
    for (const trigger of LEGACY_EVENT_UPDATE_GUARDS) {
      await conn.query(
        `CREATE TRIGGER \`${trigger}\`
           BEFORE UPDATE ON legacy_tombstone_compensation_events
           FOR EACH ROW
           SIGNAL SQLSTATE '45000'
             SET MESSAGE_TEXT = 'legacy tombstone compensation events are append-only'`,
      );
    }
  }
}

async function injectCanonicalUserHold(
  conn: Connection,
  tenantId: string,
  userId: string,
  holdId: string,
): Promise<void> {
  await conn.beginTransaction();
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT control_generation, active_hold_count, active_projection_sha256, updated_at_ms
         FROM legal_hold_controls
        WHERE tenant_id=? AND subject_kind='user' AND subject_id=? FOR UPDATE`,
      [tenantId, userId],
    );
    const row = rows[0];
    const before: LegalHoldControlRecord = row
      ? {
          tenantId,
          subjectKind: "user",
          subjectId: userId,
          controlGeneration: Number(row.control_generation),
          activeHoldCount: Number(row.active_hold_count),
          activeProjectionSha256: String(row.active_projection_sha256),
          updatedAtMs: Number(row.updated_at_ms),
        }
      : {
          tenantId,
          subjectKind: "user",
          subjectId: userId,
          controlGeneration: 0,
          activeHoldCount: 0,
          activeProjectionSha256: legalHoldProjectionSha256([]),
          updatedAtMs: 0,
        };
    if (!row) {
      await conn.query(
        `INSERT INTO legal_hold_controls
           (tenant_id, subject_kind, subject_id, control_generation, active_hold_count,
            active_projection_sha256, updated_at_ms)
         VALUES (?,'user',?,0,0,?,0)`,
        [tenantId, userId, before.activeProjectionSha256],
      );
    }
    const atMs = Math.max(before.updatedAtMs, await databaseNow(conn));
    const hold: LegalHoldRecord = {
      tenantId,
      holdId,
      subjectKind: "user",
      subjectId: userId,
      state: "active",
      reasonCode: "litigation",
      createdControlGeneration: before.controlGeneration + 1,
      createdByKeyId: "test-legal-admin",
      createdAtMs: atMs,
    };
    const after: LegalHoldControlRecord = {
      tenantId,
      subjectKind: "user",
      subjectId: userId,
      controlGeneration: hold.createdControlGeneration,
      activeHoldCount: 1,
      activeProjectionSha256: legalHoldProjectionSha256([hold]),
      updatedAtMs: atMs,
    };
    await conn.query(
      `INSERT INTO legal_holds
         (tenant_id, hold_id, subject_kind, subject_id, state, reason_code,
          external_reference_sha256, created_control_generation, created_by_key_id,
          created_at_ms, released_control_generation, released_by_key_id, released_at_ms,
          release_reason_code)
       VALUES (?,?,'user',?,'active','litigation',NULL,?,?,?,NULL,NULL,NULL,NULL)`,
      [tenantId, holdId, userId, hold.createdControlGeneration, hold.createdByKeyId, atMs],
    );
    await conn.query(
      `UPDATE legal_hold_controls
          SET control_generation=?, active_hold_count=1, active_projection_sha256=?,
              updated_at_ms=?
        WHERE tenant_id=? AND subject_kind='user' AND subject_id=?
          AND control_generation=?`,
      [
        after.controlGeneration,
        after.activeProjectionSha256,
        atMs,
        tenantId,
        userId,
        before.controlGeneration,
      ],
    );
    await conn.query(
      `UPDATE subject_lifecycle SET legal_hold_at_ms=?, updated_at_ms=GREATEST(updated_at_ms, ?)
        WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
      [atMs, atMs, tenantId, userId],
    );
    await conn.query(
      `INSERT INTO legal_hold_events
         (tenant_id, subject_kind, subject_id, control_generation, hold_id, event_type,
          reason_code, external_reference_sha256, actor_key_id, before_sha256,
          after_sha256, emitted_at_ms)
       VALUES (?,'user',?,?,?,'legal_hold/set','litigation',NULL,?,?,?,?)`,
      [
        tenantId,
        userId,
        after.controlGeneration,
        holdId,
        hold.createdByKeyId,
        legalHoldControlSha256(before),
        legalHoldControlSha256(after),
        atMs,
      ],
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}

type ClockOverrideStore = {
  databaseNow(connection: unknown): Promise<number>;
};

async function withDatabaseClockSequence<T>(
  store: MysqlSessionStore,
  values: readonly number[],
  operation: () => Promise<T>,
): Promise<T> {
  const clock = store as unknown as ClockOverrideStore;
  const original = clock.databaseNow;
  let index = 0;
  clock.databaseNow = async () => values[Math.min(index++, values.length - 1)]!;
  try {
    return await operation();
  } finally {
    clock.databaseNow = original;
  }
}

async function advanceThroughT3c(
  store: MysqlSessionStore,
  tenantId: string,
  userId: string,
  contentRetentionMs = 0,
  beforeTenantErasure?: (session: ReturnType<typeof mkSession>) => Promise<void>,
) {
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await installPolicy(store, tenantId, contentRetentionMs);
  const session = mkSession(tenantId, userId);
  await store.createSession(session);
  await beforeTenantErasure?.(session);
  if ((await store.readTenantCredentialTrackingCutover()).controlGeneration === 0) {
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
  }
  const requestId = newErasureRequestId();
  await store.requestTenantErasure({
    requestId,
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey: `tenant-purge-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: Date.now(),
  });
  const credential = (await store.claimTenantCredentialRevocations({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `credential-${randomUUID()}`,
  })).find((claim) => claim.requestId === requestId)!;
  const credentialReceipt = await store.revokeTenantCredentialMaterial(
    credentialAuthorization(credential),
  );
  if (!credentialReceipt) throw new Error("missing T3a receipt");
  await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
  const runtime = (await store.claimTenantRuntimeRevocations({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `runtime-${randomUUID()}`,
  })).find((claim) => claim.requestId === requestId)!;
  const runtimeReceipt = await store.completeTenantRuntimeRevocation(
    runtimeAuthorization(runtime),
    fleetProof(runtime),
  );
  if (!runtimeReceipt) throw new Error("missing T3b receipt");
  await store.materializeTenantContentInventoryJobs({ limit: 10 });
  const content = (await store.claimTenantContentInventories({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `content-${randomUUID()}`,
  })).find((claim) => claim.requestId === requestId)!;
  const contentAuth = contentAuthorization(content);
  let done = false;
  while (!done) {
    const page = await store.buildTenantContentInventoryPage(contentAuth, { limit: 10 });
    done = page.done;
  }
  const contentReceipt = await store.sealTenantContentInventory(contentAuth);
  if (!contentReceipt) throw new Error("missing T3c receipt");
  return { requestId, session, credentialReceipt, runtimeReceipt, contentReceipt };
}

async function claimPlan(store: MysqlSessionStore, requestId: string, leaseMs = 120_000) {
  const claim = (await store.claimTenantPurgePlans({
    limit: 10,
    leaseMs,
    claimToken: `plan-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!claim) throw new Error("missing T3d claim");
  return claim;
}

async function claimUserDataExport(
  store: MysqlSessionStore,
  requestId: string,
): Promise<UserDataExportAuthorization> {
  const claim = (await store.claimUserDataExports({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `tenant-plan-export-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!claim) throw new Error("missing user export claim");
  return userDataExportAuthorization(claim);
}

async function publishReadyUserDataExport(
  store: MysqlSessionStore,
  authorization: UserDataExportAuthorization,
): Promise<string> {
  const summary = await store.captureAndSealUserDataExportSnapshot(authorization);
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
  const bytes = Buffer.from(`tenant-plan-export:${authorization.requestId}\n`, "utf8");
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
  await store.completeUserDataExportArtifact(authorization, {
    artifactId,
    snapshotAtMs: summary.snapshotAtMs,
    partCount: 1,
    recordCount: summary.recordCount,
    totalSizeBytes: bytes.byteLength,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    manifestSha256: userDataExportManifestSha256([part]),
  });
  return artifactId;
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant purge plan", () => {
    let baseUrl: URL;
    let admin: Connection | undefined;
    let database = "";
    let mysqlUrl = "";

    beforeAll(async () => {
      baseUrl = assertDisposableTestTarget(BASE_MYSQL_URL);
      admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
    });

    beforeEach(async () => {
      database = `agent_service_purge_test_${process.pid}_${randomUUID()
        .replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_purge_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe tenant purge plan test database name");
      }
      await admin!.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      mysqlUrl = databaseUrl(baseUrl, database);
      const migrated = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1 });
      await migrated.close();
    });

    afterEach(async () => {
      if (admin && database) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      database = "";
      mysqlUrl = "";
    });

    afterAll(async () => {
      await admin?.end();
    });

    it("seals the fixed catalog without deleting data and isolates tenant-bound authority", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-plan-success-${randomUUID()}`;
      const userId = `private-user-${randomUUID()}`;
      try {
        const source = await advanceThroughT3c(store, tenantId, userId);
        const [before] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM sessions WHERE tenant_id=?) AS sessions,
             (SELECT COUNT(*) FROM events e JOIN sessions s ON s.session_id=e.session_id
               WHERE s.tenant_id=?) AS events,
             (SELECT state FROM subject_lifecycle WHERE tenant_id=?
               AND subject_kind='tenant' AND subject_id=?) AS lifecycle_state`,
          [tenantId, tenantId, tenantId, tenantId],
        );
        expect(await store.materializeTenantPurgePlanJobs({ limit: 10 })).toBe(1);
        expect(await store.materializeTenantPurgePlanJobs({ limit: 10 })).toBe(0);
        const claim = await claimPlan(store, source.requestId);
        const authorization = planAuthorization(claim);

        const wrongTenantAuthorization = {
          ...authorization,
          tenantId: `wrong-${tenantId}`,
        };
        expect(await store.renewTenantPurgePlan(wrongTenantAuthorization, { leaseMs: 1_000 }))
          .toBe(false);
        expect(await store.sealTenantPurgePlan(wrongTenantAuthorization)).toBeNull();
        expect(await store.getTenantPurgePlanJob(`wrong-${tenantId}`, source.requestId)).toBeNull();
        expect(await store.getTenantPurgePlanEntries(
          `wrong-${tenantId}`,
          source.requestId,
          claim.buildGeneration,
        )).toEqual([]);

        let done = false;
        while (!done) {
          const page = await store.buildTenantPurgePlanPage(authorization, { limit: 4 });
          done = page.done;
        }
        const entries = await store.getTenantPurgePlanEntries(
          tenantId,
          source.requestId,
          claim.buildGeneration,
        );
        expect(entries.map((entry) => entry.domain)).toEqual(TENANT_PURGE_PLAN_DOMAINS);
        expect(entries).toHaveLength(33);
        expect(entries.filter((entry) => entry.disposition.startsWith("blocked_")))
          .toHaveLength(9);
        for (const domain of ["backup_ledger", "restore_ledger", "logs", "traces"] as const) {
          expect(entries.find((entry) => entry.domain === domain)?.targetCount).toBe(0);
        }
        expect(entries.find((entry) => entry.domain === "external_provider"))
          .toMatchObject({ targetCount: 0, disposition: "not_applicable" });
        expect(entries.find((entry) => entry.domain === "kms"))
          .toMatchObject({ targetCount: 0, disposition: "not_applicable" });
        const serialized = JSON.stringify(entries);
        expect(serialized).not.toContain(userId);
        expect(serialized).not.toContain(source.session.id);
        expect(serialized).not.toContain(authorization.claimToken);

        const receipt = await store.sealTenantPurgePlan(authorization);
        expect(receipt).toMatchObject({
          tenantId,
          planEntryCount: 33,
          blockerCount: 9,
          planComplete: true,
          executionReady: false,
          contentPurgeExecuted: false,
        });
        expect(await store.sealTenantPurgePlan(authorization)).toEqual(receipt);
        expect(await store.sealTenantPurgePlan({
          ...authorization,
          claimToken: `different-${randomUUID()}`,
        })).toBeNull();
        expect(await store.getTenantPurgePlanReceipt(
          `wrong-${tenantId}`,
          source.requestId,
        )).toBeNull();

        const [after] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM sessions WHERE tenant_id=?) AS sessions,
             (SELECT COUNT(*) FROM events e JOIN sessions s ON s.session_id=e.session_id
               WHERE s.tenant_id=?) AS events,
             (SELECT state FROM subject_lifecycle WHERE tenant_id=?
               AND subject_kind='tenant' AND subject_id=?) AS lifecycle_state`,
          [tenantId, tenantId, tenantId, tenantId],
        );
        expect(after[0]).toMatchObject(before[0]!);
        expect(String(after[0]?.lifecycle_state)).toBe("deleting");
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("does not let a held job starve claims but blocks its page, deadline, and clock", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-plan-hold-${randomUUID()}`;
      const userId = `held-user-${randomUUID()}`;
      try {
        const source = await advanceThroughT3c(store, tenantId, userId);
        await injectCanonicalUserHold(conn, tenantId, userId, "hold_tenant_plan_user");
        const neighborTenant = `tenant-plan-neighbor-${randomUUID()}`;
        const neighborUser = `neighbor-user-${randomUUID()}`;
        const neighbor = await advanceThroughT3c(
          store,
          neighborTenant,
          neighborUser,
        );
        expect(await store.materializeTenantPurgePlanJobs({ limit: 10 })).toBe(2);
        const claims = await store.claimTenantPurgePlans({
          limit: 10,
          leaseMs: 120_000,
          claimToken: `hold-page-${randomUUID()}`,
        });
        const heldClaim = claims.find((claim) => claim.requestId === source.requestId)!;
        const neighborClaim = claims.find((claim) => claim.requestId === neighbor.requestId)!;
        expect(heldClaim).toBeDefined();
        expect(neighborClaim).toBeDefined();
        await expect(store.buildTenantPurgePlanPage(planAuthorization(heldClaim), { limit: 1 }))
          .rejects.toMatchObject({ reason: "active_legal_hold" });
        expect((await store.buildTenantPurgePlanPage(
          planAuthorization(neighborClaim),
          { limit: 1 },
        )).built).toBe(1);
        expect((await store.buildTenantPurgePlanPage(
          planAuthorization(neighborClaim),
          { limit: 33 },
        )).done).toBe(true);
        await injectCanonicalUserHold(
          conn,
          neighborTenant,
          neighborUser,
          "hold_after_complete_page",
        );
        await expect(store.sealTenantPurgePlan(planAuthorization(neighborClaim)))
          .rejects.toMatchObject({ reason: "active_legal_hold" });
        expect(await store.getTenantPurgePlanReceipt(neighborTenant, neighbor.requestId)).toBeNull();

        const deadlineTenant = `tenant-plan-deadline-${randomUUID()}`;
        const deadline = await advanceThroughT3c(
          store,
          deadlineTenant,
          `deadline-user-${randomUUID()}`,
          1,
        );
        expect(await store.materializeTenantPurgePlanJobs({ limit: 10 })).toBe(1);
        const deadlineClaim = await claimPlan(store, deadline.requestId);
        const authorization = planAuthorization(deadlineClaim);
        const job = await store.getTenantPurgePlanJob(deadlineTenant, deadline.requestId);
        expect(job?.purgeNotBeforeDbMs).toBeGreaterThan(job!.retentionAnchorDbMs);
        await expect(withDatabaseClockSequence(
          store,
          [job!.purgeNotBeforeDbMs - 1],
          () => store.buildTenantPurgePlanPage(authorization, { limit: 1 }),
        )).rejects.toMatchObject({ reason: "deadline_not_reached" });
        expect(await store.getTenantPurgePlanEntries(
          deadlineTenant,
          deadline.requestId,
          deadlineClaim.buildGeneration,
        )).toEqual([]);

        const clockTenant = `tenant-plan-clock-${randomUUID()}`;
        const clock = await advanceThroughT3c(
          store,
          clockTenant,
          `clock-user-${randomUUID()}`,
        );
        await expect(withDatabaseClockSequence(
          store,
          [clock.contentReceipt.storeDbTimestampMs - 1],
          () => store.materializeTenantPurgePlanJobs({ limit: 10 }),
        )).rejects.toMatchObject({ reason: "trusted_clock_before_source" });
        expect(await store.getTenantPurgePlanJob(clockTenant, clock.requestId)).toBeNull();
        expect(await store.materializeTenantPurgePlanJobs({ limit: 10 })).toBe(1);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("claims once across concurrent stores and rolls page and seal back after lease expiry", async () => {
      const first = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const second = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const tenantId = `tenant-plan-race-${randomUUID()}`;
      try {
        const source = await advanceThroughT3c(first, tenantId, `race-user-${randomUUID()}`);
        await first.materializeTenantPurgePlanJobs({ limit: 10 });
        const [left, right] = await Promise.all([
          first.claimTenantPurgePlans({
            limit: 1,
            leaseMs: 300_000,
            claimToken: `left-${randomUUID()}`,
          }),
          second.claimTenantPurgePlans({
            limit: 1,
            leaseMs: 300_000,
            claimToken: `right-${randomUUID()}`,
          }),
        ]);
        const claims = [...left, ...right].filter((claim) => claim.requestId === source.requestId);
        expect(claims).toHaveLength(1);
        const claim = claims[0]!;
        const owner = left.includes(claim) ? first : second;
        const authorization = planAuthorization(claim);

        await expect(withDatabaseClockSequence(
          owner,
          [claim.leaseUntilMs - 1, claim.leaseUntilMs],
          () => owner.buildTenantPurgePlanPage(authorization, { limit: 1 }),
        )).rejects.toThrow("lease expired");
        expect(await owner.getTenantPurgePlanEntries(
          tenantId,
          source.requestId,
          claim.buildGeneration,
        )).toEqual([]);

        expect((await owner.buildTenantPurgePlanPage(authorization, { limit: 33 })).done).toBe(true);
        await expect(withDatabaseClockSequence(
          owner,
          [claim.leaseUntilMs - 1, claim.leaseUntilMs - 1, claim.leaseUntilMs],
          () => owner.sealTenantPurgePlan(authorization),
        )).rejects.toThrow("lease expired");
        expect(await owner.getTenantPurgePlanReceipt(tenantId, source.requestId)).toBeNull();
        const receipt = await owner.sealTenantPurgePlan(authorization);
        expect(receipt?.planComplete).toBe(true);
        expect(await owner.sealTenantPurgePlan(authorization)).toEqual(receipt);
      } finally {
        await second.close();
        await first.close();
      }
    });

    it("detects domain drift at seal and blocks a T3c topology-corrupt candidate", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      try {
        const driftTenant = `tenant-plan-drift-${randomUUID()}`;
        const drift = await advanceThroughT3c(store, driftTenant, `drift-user-${randomUUID()}`);
        await store.materializeTenantPurgePlanJobs({ limit: 10 });
        const driftClaim = await claimPlan(store, drift.requestId);
        const driftAuthorization = planAuthorization(driftClaim);
        expect((await store.buildTenantPurgePlanPage(
          driftAuthorization,
          { limit: 33 },
        )).done).toBe(true);
        await conn.query(
          `INSERT INTO agent_versions (tenant_id, agent_id, version, definition, created_at_ms)
           VALUES (?,?,1,JSON_OBJECT('id',?,'version',1),?)`,
          [driftTenant, "agent-after-plan", "agent-after-plan", Date.now()],
        );
        await expect(store.sealTenantPurgePlan(driftAuthorization))
          .rejects.toBeInstanceOf(TenantPurgePlanEvidenceChangedError);
        expect(await store.getTenantPurgePlanReceipt(driftTenant, drift.requestId)).toBeNull();
        expect(await store.blockTenantPurgePlan(driftAuthorization)).toBe(true);

        const corruptTenant = `tenant-plan-corrupt-${randomUUID()}`;
        const corrupt = await advanceThroughT3c(
          store,
          corruptTenant,
          `corrupt-user-${randomUUID()}`,
        );
        await store.materializeTenantPurgePlanJobs({ limit: 10 });
        const phantomSessionId = newId("sess");
        await conn.query(
          `INSERT INTO sessions
             (session_id, tenant_id, user_id, agent_id, agent_version, status, title,
              parent_session_id, last_seq, fence_token, context_epoch, usage_json, metadata,
              created_at_ms, updated_at_ms, archived_at_ms, deleted_at_ms, purge_after_ms,
              deletion_generation)
           SELECT ?, tenant_id, user_id, agent_id, agent_version, status, title,
                  NULL, 0, 0, context_epoch, usage_json, metadata, created_at_ms, updated_at_ms,
                  NULL, NULL, NULL, 0
             FROM sessions WHERE session_id=?`,
          [phantomSessionId, corrupt.session.id],
        );
        const claims = await store.claimTenantPurgePlans({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `corrupt-${randomUUID()}`,
        });
        expect(claims.some((claim) => claim.requestId === corrupt.requestId)).toBe(false);
        const [blocked] = await conn.query<RowDataPacket[]>(
          "SELECT phase, blocked_reason_code FROM tenant_purge_plan_jobs WHERE request_id=?",
          [corrupt.requestId],
        );
        expect(blocked[0]).toMatchObject({
          phase: "blocked",
          blocked_reason_code: "integrity_conflict",
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("atomically builds and seals an untouched plan with a generation-zero export", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-plan-direct-${randomUUID()}`;
      const userId = `direct-user-${randomUUID()}`;
      const exportRequestId = newUserDataExportRequestId();
      try {
        const source = await advanceThroughT3c(
          store,
          tenantId,
          userId,
          0,
          async () => {
            const request = await store.requestUserDataExport({
              requestId: exportRequestId,
              tenantId,
              userId,
              requestedByKeyId: "tenant-plan-export-admin",
              idempotencyKeySha256: userDataExportIdempotencyKeySha256(
                `tenant-plan-export-${randomUUID()}`,
              ),
              requestHash: userDataExportRequestHash(tenantId, userId),
            });
            expect(request.subjectGeneration).toBe(0);
            expect(request.currentBuildGeneration).toBe(0);
          },
        );
        const [exportRows] = await conn.query<RowDataPacket[]>(
          `SELECT r.subject_generation, r.active_build_generation, j.build_generation
             FROM user_export_requests r
             JOIN user_export_jobs j ON j.request_id=r.request_id
            WHERE r.request_id=?`,
          [exportRequestId],
        );
        expect(exportRows[0]).toMatchObject({
          subject_generation: 0,
          active_build_generation: 0,
          build_generation: 0,
        });

        expect(await store.materializeTenantPurgePlanJobs({ limit: 10 })).toBe(1);
        const claim = await claimPlan(store, source.requestId);
        const receipt = await store.sealTenantPurgePlan(planAuthorization(claim));
        expect(receipt).toMatchObject({
          planEntryCount: TENANT_PURGE_PLAN_DOMAINS.length,
          planComplete: true,
          executionReady: false,
          contentPurgeExecuted: false,
        });
        const entries = await store.getTenantPurgePlanEntries(
          tenantId,
          source.requestId,
          claim.buildGeneration,
        );
        expect(entries.map((entry) => entry.domain)).toEqual(TENANT_PURGE_PLAN_DOMAINS);
        expect(entries.find((entry) => entry.domain === "user_export_control")?.targetCount)
          .toBe(3);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("blocks both external-provider and KMS domains for a provider-secret-only tenant", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const tenantId = `tenant-plan-provider-kms-${randomUUID()}`;
      const now = Date.now();
      try {
        const source = await advanceThroughT3c(
          store,
          tenantId,
          `provider-kms-user-${randomUUID()}`,
          0,
          async () => {
            await store.upsertProviderConfig({
              tenantId,
              id: "provider-secret-only",
              api: "openai-completions",
              apiKeyRef: "provider-kms-key",
              baseUrl: "https://provider.invalid/v1",
              headers: {},
              models: [{
                id: "provider-model",
                contextWindow: 1_000,
                maxOutputTokens: 100,
                input: ["text"],
                reasoning: false,
              }],
              quota: {},
              fallback: [],
              createdAtMs: now,
              updatedAtMs: now,
            }, {
              ciphertext: Buffer.from("provider-secret-ciphertext", "utf8"),
              keyId: "provider-kms-key",
            });
          },
        );
        expect(source.credentialReceipt).toMatchObject({
          providerConfigCountBefore: 1,
          authSecretCipherPresentBefore: false,
          authSecretKeyIdPresentBefore: false,
        });

        await store.materializeTenantPurgePlanJobs({ limit: 10 });
        const claim = await claimPlan(store, source.requestId);
        const receipt = await store.sealTenantPurgePlan(planAuthorization(claim));
        expect(receipt).toMatchObject({ planComplete: true, blockerCount: 11 });
        const entries = await store.getTenantPurgePlanEntries(
          tenantId,
          source.requestId,
          claim.buildGeneration,
        );
        expect(entries.find((entry) => entry.domain === "external_provider")).toMatchObject({
          targetCount: 2,
          disposition: "blocked_legacy_external_source_unavailable",
        });
        expect(entries.find((entry) => entry.domain === "kms")).toMatchObject({
          targetCount: 2,
          disposition: "blocked_legacy_external_source_unavailable",
        });
      } finally {
        await store.close();
      }
    });

    it("blocks only KMS for a tenant-auth-secret-only tenant", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const tenantId = `tenant-plan-auth-kms-${randomUUID()}`;
      try {
        const source = await advanceThroughT3c(
          store,
          tenantId,
          `auth-kms-user-${randomUUID()}`,
          0,
          async () => {
            await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY, {
              ciphertext: Buffer.from("tenant-auth-secret-ciphertext", "utf8"),
              keyId: "tenant-auth-kms-key",
            });
          },
        );
        expect(source.credentialReceipt).toMatchObject({
          providerConfigCountBefore: 0,
          authSecretCipherPresentBefore: true,
          authSecretKeyIdPresentBefore: true,
        });

        await store.materializeTenantPurgePlanJobs({ limit: 10 });
        const claim = await claimPlan(store, source.requestId);
        const receipt = await store.sealTenantPurgePlan(planAuthorization(claim));
        expect(receipt).toMatchObject({ planComplete: true, blockerCount: 10 });
        const entries = await store.getTenantPurgePlanEntries(
          tenantId,
          source.requestId,
          claim.buildGeneration,
        );
        expect(entries.find((entry) => entry.domain === "external_provider")).toMatchObject({
          targetCount: 0,
          disposition: "not_applicable",
        });
        expect(entries.find((entry) => entry.domain === "kms")).toMatchObject({
          targetCount: 2,
          disposition: "blocked_legacy_external_source_unavailable",
        });
      } finally {
        await store.close();
      }
    });

    it("distinguishes same-expiry download leases and accepts released snapshot generation drift", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-plan-export-leases-${randomUUID()}`;
      const userId = `export-lease-user-${randomUUID()}`;
      const exportRequestId = newUserDataExportRequestId();
      const firstLeaseToken = `download-first-${randomUUID()}`;
      const secondLeaseToken = `download-second-${randomUUID()}`;
      let artifactId = "";
      let sourceBlobId = "";
      try {
        const source = await advanceThroughT3c(
          store,
          tenantId,
          userId,
          0,
          async (session) => {
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
              idempotencyKey: `export-attachment-${randomUUID()}`,
            };
            sourceBlobId = newId("blob");
            const sourceStorageKey = `objects/${sourceBlobId.slice("blob_".length)}`;
            const sourceUploadToken = `upload-${sourceBlobId.slice("blob_".length)}`;
            await store.stageBlob({
              owner: { tenantId, userId },
              sessionId: session.id,
              fence: 1,
              blobId: sourceBlobId,
              purpose: "tool_output",
              storageBackend: "memory-v1",
              storageFormat: BLOB_STORAGE_FORMAT,
              storageKey: sourceStorageKey,
              uploadToken: sourceUploadToken,
              createdAtMs: now,
              stagingExpiresAtMs: now + 60_000,
            });
            await store.markBlobUploaded({
              owner: { tenantId, userId },
              sessionId: session.id,
              fence: 1,
              blobId: sourceBlobId,
              uploadToken: sourceUploadToken,
              sha256: "a".repeat(64),
              sizeBytes: 128,
              contentType: "application/json",
              uploadedAtMs: now + 1,
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
              toolCallId: "call-tenant-plan-export",
              name: "large_output",
              content: [],
              isError: false,
              outputRef: sourceBlobId,
            };
            await store.commit({
              sessionId: session.id,
              fence: 2,
              turn,
              items: [item],
              blobBindings: [{ blobId: sourceBlobId, itemId: item.id, purpose: "tool_output" }],
              events: [
                { type: "turn/started", sessionId: session.id, emittedAtMs: now + 2, turn },
                { type: "item/completed", sessionId: session.id, emittedAtMs: now + 3, item },
              ],
            });

            await store.requestUserDataExport({
              requestId: exportRequestId,
              tenantId,
              userId,
              requestedByKeyId: "tenant-plan-export-admin",
              idempotencyKeySha256: userDataExportIdempotencyKeySha256(
                `tenant-plan-lease-export-${randomUUID()}`,
              ),
              requestHash: userDataExportRequestHash(tenantId, userId),
            });
            const exportAuthorization = await claimUserDataExport(store, exportRequestId);
            artifactId = await publishReadyUserDataExport(store, exportAuthorization);
            expect(await store.acquireUserDataExportDownload(
              tenantId,
              userId,
              exportRequestId,
              firstLeaseToken,
              60_000,
            )).not.toBeNull();
            expect(await store.acquireUserDataExportDownload(
              tenantId,
              userId,
              exportRequestId,
              secondLeaseToken,
              60_000,
            )).not.toBeNull();
            const [leaseRows] = await conn.query<RowDataPacket[]>(
              `SELECT lease_token, lease_until_ms FROM user_export_download_leases
                WHERE artifact_id=? ORDER BY lease_token`,
              [artifactId],
            );
            expect(leaseRows).toHaveLength(2);
            const commonLeaseUntilMs = Math.max(
              ...leaseRows.map((row) => Number(row.lease_until_ms)),
            );
            await conn.query(
              "UPDATE user_export_download_leases SET lease_until_ms=? WHERE artifact_id=?",
              [commonLeaseUntilMs, artifactId],
            );

            const [snapshotRows] = await conn.query<RowDataPacket[]>(
              `SELECT released_at_ms, source_deletion_generation
                 FROM user_export_snapshot_blobs
                WHERE request_id=? AND build_generation=1 AND blob_id=?`,
              [exportRequestId, sourceBlobId],
            );
            expect(snapshotRows[0]?.released_at_ms).not.toBeNull();
            expect(Number(snapshotRows[0]?.source_deletion_generation)).toBe(0);
            const [advanced] = await conn.query<mysql.ResultSetHeader>(
              `UPDATE blob_objects
                  SET state='delete_pending', delete_after_ms=?, deletion_generation=1
                WHERE blob_id=? AND state='ready' AND deletion_generation=0`,
              [now + 4, sourceBlobId],
            );
            expect(advanced.affectedRows).toBe(1);
            await conn.query(
              `INSERT INTO blob_delete_outbox
                 (blob_id, generation, available_at_ms, attempts, created_at_ms)
               VALUES (?,1,NULL,0,?)`,
              [sourceBlobId, now + 4],
            );
          },
        );
        const [leaseRows] = await conn.query<RowDataPacket[]>(
          `SELECT lease_token, lease_until_ms FROM user_export_download_leases
            WHERE artifact_id=? ORDER BY lease_token`,
          [artifactId],
        );
        expect(leaseRows.map((row) => String(row.lease_token))).toEqual(
          [firstLeaseToken, secondLeaseToken].sort(),
        );
        expect(new Set(leaseRows.map((row) => Number(row.lease_until_ms))).size).toBe(1);

        await store.materializeTenantPurgePlanJobs({ limit: 10 });
        const claim = await claimPlan(store, source.requestId);
        const receipt = await store.sealTenantPurgePlan(planAuthorization(claim));
        expect(receipt?.planComplete).toBe(true);
        const entries = await store.getTenantPurgePlanEntries(
          tenantId,
          source.requestId,
          claim.buildGeneration,
        );
        expect(entries.find((entry) => entry.domain === "user_export_control")?.targetCount)
          .toBe(5);
        expect(entries.find((entry) => entry.domain === "user_export_snapshots")?.targetCount)
          .toBe(1);
        const publicProof = JSON.stringify({ entries, receipt });
        expect(publicProof).not.toContain(firstLeaseToken);
        expect(publicProof).not.toContain(secondLeaseToken);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls direct-seal entries, progress, and receipt back when its lease expires", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-plan-direct-rollback-${randomUUID()}`;
      try {
        const source = await advanceThroughT3c(
          store,
          tenantId,
          `direct-rollback-user-${randomUUID()}`,
        );
        await store.materializeTenantPurgePlanJobs({ limit: 10 });
        const claim = await claimPlan(store, source.requestId);
        const beforeExpiry = claim.leaseUntilMs - 1;
        await expect(withDatabaseClockSequence(
          store,
          [beforeExpiry, beforeExpiry, beforeExpiry, claim.leaseUntilMs],
          () => store.sealTenantPurgePlan(planAuthorization(claim)),
        )).rejects.toThrow("lease expired while publishing the aggregate");
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_purge_plan_entries WHERE request_id=?) AS entry_count,
             (SELECT COUNT(*) FROM tenant_purge_plan_receipts WHERE request_id=?) AS receipt_count,
             phase, scan_complete, plan_entry_count, cursor_domain,
             aggregate_receipt_sha256, sealed_at_ms
           FROM tenant_purge_plan_jobs WHERE request_id=?`,
          [source.requestId, source.requestId, source.requestId],
        );
        expect(Number(rows[0]?.entry_count)).toBe(0);
        expect(Number(rows[0]?.receipt_count)).toBe(0);
        expect(rows[0]).toMatchObject({
          phase: "queued",
          scan_complete: 0,
          plan_entry_count: 0,
          cursor_domain: null,
          aggregate_receipt_sha256: null,
          sealed_at_ms: null,
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls direct seal back for global receipt and usage owner corruption", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-plan-owner-closure-${randomUUID()}`;
      const userId = `owner-closure-user-${randomUUID()}`;
      const validIdempotencyKey = `valid-live-${randomUUID()}`;
      const validUsageTurnId = newId("turn");
      try {
        const source = await advanceThroughT3c(
          store,
          tenantId,
          userId,
          0,
          async (session) => {
            // Live generation-zero sessions are valid owners. In particular, legacy operational
            // usage is not required to have a matching turn row.
            await conn.query(
              `INSERT INTO idempotency_keys
                 (tenant_id, user_id, session_id, idem_key, request_hash, value, expires_at_ms)
               VALUES (?,?,?,?,NULL,NULL,?)`,
              [tenantId, userId, session.id, validIdempotencyKey, Date.now() + 60_000],
            );
            await conn.query(
              `INSERT INTO usage_ledger
                 (usage_id, tenant_id, user_id, session_id, turn_id, step, provider, model,
                  usage_json, created_at_ms)
               VALUES (NULL,?,?,?,?,1,'legacy-provider','legacy-model',?,?)`,
              [
                tenantId,
                userId,
                session.id,
                validUsageTurnId,
                JSON.stringify(emptyUsage()),
                Date.now(),
              ],
            );
          },
        );
        await store.materializeTenantPurgePlanJobs({ limit: 10 });
        const claim = await claimPlan(store, source.requestId);
        const authorization = planAuthorization(claim);

        // Build valid global controls outside the planned tenant: one live generation-zero
        // session with a completed receipt, and one positive-generation tombstone with a real
        // reconciliation produced through the public store path.
        const supportTenantId = `tenant-plan-owner-support-${randomUUID()}`;
        const supportUserId = `owner-support-user-${randomUUID()}`;
        const reconciledSession = mkSession(supportTenantId, supportUserId);
        const liveSession = mkSession(supportTenantId, supportUserId);
        const legacySession = mkSession(supportTenantId, supportUserId);
        await store.createSession(reconciledSession);
        await store.createSession(liveSession);
        await store.createSession(legacySession);
        const legacyDeletedAtMs = Math.max(
          legacySession.createdAtMs,
          legacySession.updatedAtMs,
        ) + 1;
        await store.commit({
          sessionId: legacySession.id,
          fence: 1,
          lifecycle: {
            type: "tombstone",
            tenantId: supportTenantId,
            userId: supportUserId,
            deletionGeneration: 1,
            atMs: legacyDeletedAtMs,
          },
          events: [{
            type: "session/deleted",
            sessionId: legacySession.id,
            deletionGeneration: 1,
            emittedAtMs: legacyDeletedAtMs,
          }],
        });
        const legacySourceLastSeq = 1;
        const legacyCompletedEventSeq = 2;
        const legacyJobId = legacyTombstoneCompensationJobIdForSession(legacySession.id);
        const supportTurn: Turn = {
          id: newId("turn"),
          sessionId: liveSession.id,
          status: "inProgress",
          seqStart: 2,
          steps: 0,
          toolCalls: 0,
          usage: emptyUsage(),
          startedAtMs: Date.now(),
          idempotencyKey: `support-turn-${randomUUID()}`,
        };
        await store.commit({
          sessionId: liveSession.id,
          fence: 1,
          turn: supportTurn,
          events: [{
            type: "turn/started",
            sessionId: liveSession.id,
            emittedAtMs: supportTurn.startedAtMs,
            turn: supportTurn,
          }],
        });
        const completedIdempotencyKey = `completed-support-${randomUUID()}`;
        // Frozen pre-current fixtures stored only turnId. The global validator must derive the
        // session through the turn rather than requiring a newly-added embedded sessionId.
        const legacyCompletedIdempotencyValue = { turnId: supportTurn.id };
        await conn.query(
          `INSERT INTO idempotency_keys
             (tenant_id, user_id, session_id, idem_key, request_hash, value, expires_at_ms)
           VALUES (?,?,?,?,?,?,?)`,
          [
            supportTenantId,
            supportUserId,
            liveSession.id,
            completedIdempotencyKey,
            "a".repeat(64),
            JSON.stringify(legacyCompletedIdempotencyValue),
            Date.now() + 60_000,
          ],
        );
        const reconciledAtMs = Date.now();
        await store.commit({
          sessionId: reconciledSession.id,
          fence: 1,
          lifecycle: {
            type: "tombstone",
            tenantId: supportTenantId,
            userId: supportUserId,
            deletionGeneration: 1,
            atMs: reconciledAtMs,
          },
          events: [{
            type: "session/deleted",
            sessionId: reconciledSession.id,
            deletionGeneration: 1,
            emittedAtMs: reconciledAtMs,
          }],
        });
        const validReconciliation = await store.reconcileSessionUsage({
          tenantId: supportTenantId,
          userId: supportUserId,
          sessionId: reconciledSession.id,
          deletionGeneration: 1,
          nowMs: reconciledAtMs,
        });
        expect(validReconciliation).toMatchObject({
          sessionId: reconciledSession.id,
          deletionGeneration: 1,
          status: "verified",
        });
        const userErasureRequestId = newErasureRequestId();
        const userErasure = await store.requestUserErasure({
          requestId: userErasureRequestId,
          tenantId: supportTenantId,
          userId: supportUserId,
          requestedByKeyId: "owner-closure-admin",
          idempotencyKey: `owner-closure-user-${randomUUID()}`,
          requestHash: userErasureRequestHash(supportTenantId, supportUserId),
          atMs: Date.now(),
        });

        const admissionTenantId = `tenant-plan-admission-support-${randomUUID()}`;
        await store.setTenantAuth(admissionTenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(store, admissionTenantId);
        const tenantAdmissionRequestId = newErasureRequestId();
        const tenantAdmission = await store.requestTenantErasure({
          requestId: tenantAdmissionRequestId,
          tenantId: admissionTenantId,
          requestedByKeyId: "owner-closure-platform-admin",
          idempotencyKey: `owner-closure-tenant-${randomUUID()}`,
          requestHash: tenantErasureRequestHash(admissionTenantId),
          atMs: Date.now(),
        });

        const assertAtomicProjectionRolledBack = async () => {
          const [rows] = await conn.query<RowDataPacket[]>(
            `SELECT
               (SELECT COUNT(*) FROM tenant_purge_plan_entries WHERE request_id=?) AS entry_count,
               (SELECT COUNT(*) FROM tenant_purge_plan_receipts WHERE request_id=?) AS receipt_count,
               phase, scan_complete, plan_entry_count, cursor_domain,
               aggregate_receipt_sha256, sealed_at_ms
             FROM tenant_purge_plan_jobs WHERE request_id=?`,
            [source.requestId, source.requestId, source.requestId],
          );
          expect(Number(rows[0]?.entry_count)).toBe(0);
          expect(Number(rows[0]?.receipt_count)).toBe(0);
          expect(rows[0]).toMatchObject({
            phase: "queued",
            scan_complete: 0,
            plan_entry_count: 0,
            cursor_domain: null,
            aggregate_receipt_sha256: null,
            sealed_at_ms: null,
          });
        };

        const orphanSessionId = newId("sess");
        await conn.query(
          `INSERT INTO idempotency_keys
             (tenant_id, user_id, session_id, idem_key, request_hash, value, expires_at_ms)
           VALUES (?,?,?,?,NULL,NULL,?)`,
          [
            supportTenantId,
            supportUserId,
            orphanSessionId,
            `orphan-${randomUUID()}`,
            Date.now() + 60_000,
          ],
        );
        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await assertAtomicProjectionRolledBack();
        await conn.query("DELETE FROM idempotency_keys WHERE session_id=?", [orphanSessionId]);

        await conn.query(
          `UPDATE idempotency_keys SET value=?
            WHERE tenant_id=? AND user_id=? AND session_id=? AND idem_key=?`,
          [
            JSON.stringify({
              ...legacyCompletedIdempotencyValue,
              sessionId: orphanSessionId,
            }),
            supportTenantId,
            supportUserId,
            liveSession.id,
            completedIdempotencyKey,
          ],
        );
        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await assertAtomicProjectionRolledBack();
        await conn.query(
          `UPDATE idempotency_keys SET value=?
            WHERE tenant_id=? AND user_id=? AND session_id=? AND idem_key=?`,
          [
            JSON.stringify({ turnId: newId("turn") }),
            supportTenantId,
            supportUserId,
            liveSession.id,
            completedIdempotencyKey,
          ],
        );
        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await assertAtomicProjectionRolledBack();
        await conn.query(
          `UPDATE idempotency_keys SET value=?
            WHERE tenant_id=? AND user_id=? AND session_id=? AND idem_key=?`,
          [
            JSON.stringify(legacyCompletedIdempotencyValue),
            supportTenantId,
            supportUserId,
            liveSession.id,
            completedIdempotencyKey,
          ],
        );

        await conn.query(
          `INSERT INTO usage_ledger
             (usage_id, tenant_id, user_id, session_id, turn_id, step, provider, model,
              usage_json, created_at_ms)
           VALUES (NULL,?,?,?,?,1,'corrupt-provider','corrupt-model',?,?)`,
          [
            supportTenantId,
            `wrong-${supportUserId}`,
            liveSession.id,
            newId("turn"),
            JSON.stringify(emptyUsage()),
            Date.now(),
          ],
        );
        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await assertAtomicProjectionRolledBack();
        await conn.query(
          "DELETE FROM usage_ledger WHERE session_id=? AND user_id=?",
          [liveSession.id, `wrong-${supportUserId}`],
        );

        // Matching owner is insufficient while the parent session is still live. Reconciliation
        // also requires a positive generation equal to the durable tombstone generation.
        await conn.query(
          `INSERT INTO usage_reconciliations
             (tenant_id, user_id, session_id, deletion_generation, status, row_count,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              reasoning_tokens, total_tokens, known_cost_rows, cost_cny, checksum,
              verified_at_ms, anonymized_at_ms, created_at_ms, updated_at_ms)
           VALUES (?,?,?,1,'verified',0,0,0,0,0,0,0,0,NULL,?, ?,NULL,?,?)`,
          [
            supportTenantId,
            supportUserId,
            liveSession.id,
            validReconciliation.checksum,
            Date.now(),
            Date.now(),
            Date.now(),
          ],
        );
        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await assertAtomicProjectionRolledBack();
        await conn.query(
          "DELETE FROM usage_reconciliations WHERE session_id=? AND deletion_generation=1",
          [liveSession.id],
        );

        await conn.query(
          `UPDATE subject_lifecycle SET active_request_id=NULL
            WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
          [supportTenantId, supportUserId],
        );
        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await assertAtomicProjectionRolledBack();
        await conn.query(
          `UPDATE subject_lifecycle
              SET state='deleting', generation=?, active_request_id=?
            WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
          [
            userErasure.generation,
            userErasureRequestId,
            supportTenantId,
            supportUserId,
          ],
        );

        await conn.query(
          `UPDATE subject_lifecycle SET active_request_id=NULL
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
          [admissionTenantId, admissionTenantId],
        );
        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await assertAtomicProjectionRolledBack();
        await conn.query(
          `UPDATE subject_lifecycle
              SET state='deleting', generation=?, active_request_id=?
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
          [
            tenantAdmission.generation,
            tenantAdmissionRequestId,
            admissionTenantId,
            admissionTenantId,
          ],
        );

        await conn.query(
          `UPDATE erasure_requests
              SET subject_kind='tenant', subject_id=tenant_id
            WHERE request_id=?`,
          [userErasureRequestId],
        );
        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await assertAtomicProjectionRolledBack();
        await conn.query(
          `UPDATE erasure_requests
              SET subject_kind='user', subject_id=?
            WHERE request_id=?`,
          [supportUserId, userErasureRequestId],
        );

        const orphanLifecycleUserId = `orphan-lifecycle-user-${randomUUID()}`;
        const orphanLifecycleRequestId = newErasureRequestId();
        const orphanLifecycleAtMs = Date.now();
        await conn.query(
          `INSERT INTO subject_lifecycle
             (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
              legal_hold_at_ms, created_at_ms, updated_at_ms)
           VALUES (?,'user',?,'deleting',1,?,NULL,?,?)`,
          [
            supportTenantId,
            orphanLifecycleUserId,
            orphanLifecycleRequestId,
            orphanLifecycleAtMs,
            orphanLifecycleAtMs,
          ],
        );
        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await assertAtomicProjectionRolledBack();
        await conn.query(
          `DELETE FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
          [supportTenantId, orphanLifecycleUserId],
        );

        const legacyCompletedAtMs = legacyDeletedAtMs + 2;
        const legacyCandidateSha256 = legacyTombstoneCandidateSha256({
          sessionId: legacySession.id,
          tenantId: supportTenantId,
          userId: supportUserId,
          deletedAtMs: legacyDeletedAtMs,
          lastSeq: legacySourceLastSeq,
        });
        const legacyCompletionSha256 = legacyTombstoneSuccessEvidenceSha256({
          jobId: legacyJobId,
          tenantId: supportTenantId,
          userId: supportUserId,
          sessionId: legacySession.id,
          cutoverGeneration: 1,
          legacyDeletedAtMs,
          deletionGeneration: 1,
          eventSeq: legacyCompletedEventSeq,
          claimAttempt: 1,
          emittedAtMs: legacyCompletedAtMs,
        });
        await conn.query(
          `INSERT INTO legacy_tombstone_compensation_jobs
             (job_id, session_id, tenant_id, user_id, source_kind, source_request_id,
              source_subject_generation, source_claim_attempt, source_claim_token_sha256,
              maintenance_actor_key_id, source_deleted_at_ms, source_last_seq, candidate_sha256,
              status, control_generation, available_at_ms, attempts, claim_token, lease_until_ms,
              last_error_code, created_at_ms, updated_at_ms, completed_at_ms,
              completed_event_seq, completed_claim_attempt, completed_claim_token_sha256)
           VALUES (?,?,?,?,'erasure_claim',?,?,1,?,NULL,?,?,?,'completed',1,NULL,1,
                   NULL,NULL,NULL,?,?,?,?,1,?)`,
          [
            legacyJobId,
            legacySession.id,
            supportTenantId,
            supportUserId,
            userErasureRequestId,
            userErasure.generation,
            "c".repeat(64),
            legacyDeletedAtMs,
            legacySourceLastSeq,
            legacyCandidateSha256,
            legacyDeletedAtMs,
            legacyCompletedAtMs,
            legacyCompletedAtMs,
            legacyCompletedEventSeq,
            "d".repeat(64),
          ],
        );
        await conn.query(
          `INSERT INTO legacy_tombstone_compensation_events
             (job_id, session_id, control_generation, event_type, reason_code, actor_key_id,
              claim_attempt, source_deleted_at_ms, target_deletion_generation,
              terminal_event_seq, before_sha256, after_sha256, emitted_at_ms)
           VALUES (?,?,1,'legacy_tombstone/compensated',NULL,NULL,1,?,1,?,?,?,?)`,
          [
            legacyJobId,
            legacySession.id,
            legacyDeletedAtMs,
            legacyCompletedEventSeq,
            legacyCandidateSha256,
            legacyCompletionSha256,
            legacyCompletedAtMs,
          ],
        );

        // A forged tenant attribute would otherwise make the owner-filtered evidence query count
        // this completed job for the planned tenant and omit it from the session's real tenant.
        await conn.query(
          "UPDATE legacy_tombstone_compensation_jobs SET tenant_id=? WHERE job_id=?",
          [tenantId, legacyJobId],
        );
        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await assertAtomicProjectionRolledBack();
        await conn.query(
          `UPDATE legacy_tombstone_compensation_jobs
              SET tenant_id=?, source_subject_generation=? WHERE job_id=?`,
          [supportTenantId, userErasure.generation + 1, legacyJobId],
        );

        // Physical ownership alone is insufficient for an erasure-claim source: the exact user
        // request and lifecycle generation must still authorize the historical enqueue.
        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await assertAtomicProjectionRolledBack();
        await conn.query(
          `UPDATE legacy_tombstone_compensation_jobs
              SET source_subject_generation=? WHERE job_id=?`,
          [userErasure.generation, legacyJobId],
        );

        // Matching the mutable job hash to a jointly corrupted append-only event is not enough:
        // the candidate must be recomputed from the exact owner, deletion time, and source cursor.
        const forgedCandidateSha256 = "0".repeat(64);
        await conn.query(
          `UPDATE legacy_tombstone_compensation_jobs
              SET candidate_sha256=? WHERE job_id=?`,
          [forgedCandidateSha256, legacyJobId],
        );
        await injectLegacyEventCorruption(conn, async () => {
          await conn.query(
            `UPDATE legacy_tombstone_compensation_events
                SET before_sha256=? WHERE job_id=?`,
            [forgedCandidateSha256, legacyJobId],
          );
        });
        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await assertAtomicProjectionRolledBack();
        await conn.query(
          `UPDATE legacy_tombstone_compensation_jobs
              SET candidate_sha256=? WHERE job_id=?`,
          [legacyCandidateSha256, legacyJobId],
        );
        await injectLegacyEventCorruption(conn, async () => {
          await conn.query(
            `UPDATE legacy_tombstone_compensation_events
                SET before_sha256=? WHERE job_id=?`,
            [legacyCandidateSha256, legacyJobId],
          );
        });

        // Likewise a mutually consistent job/audit event cursor cannot move past the session's
        // durable lastSeq. The evidence hash is forged consistently to isolate that relation.
        const forgedCompletedEventSeq = legacyCompletedEventSeq + 1;
        const forgedCompletionSha256 = legacyTombstoneSuccessEvidenceSha256({
          jobId: legacyJobId,
          tenantId: supportTenantId,
          userId: supportUserId,
          sessionId: legacySession.id,
          cutoverGeneration: 1,
          legacyDeletedAtMs,
          deletionGeneration: 1,
          eventSeq: forgedCompletedEventSeq,
          claimAttempt: 1,
          emittedAtMs: legacyCompletedAtMs,
        });
        await conn.query(
          `UPDATE legacy_tombstone_compensation_jobs
              SET completed_event_seq=? WHERE job_id=?`,
          [forgedCompletedEventSeq, legacyJobId],
        );
        await injectLegacyEventCorruption(conn, async () => {
          await conn.query(
            `UPDATE legacy_tombstone_compensation_events
                SET terminal_event_seq=?, after_sha256=? WHERE job_id=?`,
            [forgedCompletedEventSeq, forgedCompletionSha256, legacyJobId],
          );
        });
        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await assertAtomicProjectionRolledBack();
        await conn.query(
          `UPDATE legacy_tombstone_compensation_jobs
              SET completed_event_seq=? WHERE job_id=?`,
          [legacyCompletedEventSeq, legacyJobId],
        );
        await injectLegacyEventCorruption(conn, async () => {
          await conn.query(
            `UPDATE legacy_tombstone_compensation_events
                SET terminal_event_seq=?, after_sha256=? WHERE job_id=?`,
            [legacyCompletedEventSeq, legacyCompletionSha256, legacyJobId],
          );
        });

        // The exact completed job/audit shape remains valid after every injected corruption is
        // repaired, so these rejection cases cannot be attributed to unrelated fixture damage.
        const receipt = await store.sealTenantPurgePlan(authorization);
        expect(receipt).toMatchObject({
          planEntryCount: TENANT_PURGE_PLAN_DOMAINS.length,
          planComplete: true,
          executionReady: false,
          contentPurgeExecuted: false,
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rejects a purge target whose exact tombstone timestamp is stale", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-plan-target-owner-${randomUUID()}`;
      try {
        const source = await advanceThroughT3c(
          store,
          tenantId,
          `target-owner-${randomUUID()}`,
        );
        await store.materializeTenantPurgePlanJobs({ limit: 10 });
        const claim = await claimPlan(store, source.requestId);
        const authorization = planAuthorization(claim);

        const supportTenantId = `tenant-plan-target-support-${randomUUID()}`;
        const supportUserId = `target-support-user-${randomUUID()}`;
        const supportSession = mkSession(supportTenantId, supportUserId);
        await store.createSession(supportSession);
        const tombstonedAtMs = Date.now();
        await store.commit({
          sessionId: supportSession.id,
          fence: 1,
          lifecycle: {
            type: "tombstone",
            tenantId: supportTenantId,
            userId: supportUserId,
            deletionGeneration: 1,
            atMs: tombstonedAtMs,
          },
          events: [{
            type: "session/deleted",
            sessionId: supportSession.id,
            deletionGeneration: 1,
            emittedAtMs: tombstonedAtMs,
          }],
        });
        const userRequestId = newErasureRequestId();
        const userRequest = await store.requestUserErasure({
          requestId: userRequestId,
          tenantId: supportTenantId,
          userId: supportUserId,
          requestedByKeyId: "target-owner-admin",
          idempotencyKey: `target-owner-${randomUUID()}`,
          requestHash: userErasureRequestHash(supportTenantId, supportUserId),
          atMs: Date.now(),
        });
        const now = Date.now();
        // The owner and generation both match a valid tombstone, but the persisted target carries
        // a different deletion linearization timestamp and therefore cannot be purge evidence.
        await conn.query(
          `INSERT INTO erasure_policy_evaluation_jobs
             (request_id, tenant_id, subject_kind, subject_id, subject_generation,
              build_generation, cursor_session_id, target_count, target_root_sha256,
              available_at_ms, attempts, claim_token, lease_until_ms, last_error_code,
              sealed_at_ms, created_at_ms, updated_at_ms)
           VALUES (?,?,'user',?,?,1,?,1,?,NULL,0,NULL,NULL,NULL,?,?,?)`,
          [
            userRequestId,
            supportTenantId,
            supportUserId,
            userRequest.generation,
            supportSession.id,
            "b".repeat(64),
            now,
            now,
            now,
          ],
        );
        await conn.query(
          `INSERT INTO erasure_purge_targets
             (request_id, build_generation, tenant_id, user_id, session_id,
              deletion_generation, deleted_at_ms, session_content_deadline_ms,
              ready_blob_count, ready_blob_root_sha256, ready_blob_deadline_ms,
              operational_usage_status, operational_usage_verified_at_ms,
              operational_usage_checksum, operational_usage_deadline_ms,
              idempotency_receipt_count, idempotency_receipt_deadline_ms,
              export_artifact_disposition, billing_fact_disposition,
              lifecycle_audit_disposition, issue_codes, evidence_sha256)
           VALUES (?,1,?,?,?,1,?,NULL,0,?,NULL,'verified',?,?,NULL,0,NULL,
                   'none','retain','retain',JSON_ARRAY(),?)`,
          [
            userRequestId,
            supportTenantId,
            supportUserId,
            supportSession.id,
            tombstonedAtMs + 1,
            "c".repeat(64),
            now,
            "d".repeat(64),
            "e".repeat(64),
          ],
        );

        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_purge_plan_entries WHERE request_id=?) AS entry_count,
             (SELECT COUNT(*) FROM tenant_purge_plan_receipts WHERE request_id=?) AS receipt_count,
             phase, scan_complete, plan_entry_count, cursor_domain,
             aggregate_receipt_sha256, sealed_at_ms
           FROM tenant_purge_plan_jobs WHERE request_id=?`,
          [source.requestId, source.requestId, source.requestId],
        );
        expect(Number(rows[0]?.entry_count)).toBe(0);
        expect(Number(rows[0]?.receipt_count)).toBe(0);
        expect(rows[0]).toMatchObject({
          phase: "queued",
          scan_complete: 0,
          plan_entry_count: 0,
          cursor_domain: null,
          aggregate_receipt_sha256: null,
          sealed_at_ms: null,
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("holds the global idempotency range lock until atomic seal commits", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const writer = await mysql.createConnection(mysqlUrl);
      const observer = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-plan-range-lock-${randomUUID()}`;
      const insertedKey = `post-scan-${randomUUID()}`;
      const mutableStore = store as unknown as {
        tenantPurgePlanTargetEvidence: (...args: unknown[]) => Promise<unknown>;
      };
      const originalTargetEvidence = mutableStore.tenantPurgePlanTargetEvidence;
      let releaseEvidence!: () => void;
      let releaseCalled = false;
      const evidenceRelease = new Promise<void>((resolve) => {
        releaseEvidence = () => {
          if (releaseCalled) return;
          releaseCalled = true;
          resolve();
        };
      });
      let scansReached!: () => void;
      const scansObserved = new Promise<void>((resolve) => {
        scansReached = resolve;
      });
      let intercepted = false;
      let sealPending: Promise<unknown> | undefined;
      let insertPending: Promise<void> | undefined;
      try {
        const source = await advanceThroughT3c(
          store,
          tenantId,
          `range-lock-user-${randomUUID()}`,
        );
        await store.materializeTenantPurgePlanJobs({ limit: 10 });
        const claim = await claimPlan(store, source.requestId);
        mutableStore.tenantPurgePlanTargetEvidence = async (...args: unknown[]) => {
          if (!intercepted) {
            intercepted = true;
            scansReached();
            await evidenceRelease;
          }
          return await originalTargetEvidence.apply(store, args);
        };

        sealPending = store.sealTenantPurgePlan(planAuthorization(claim));
        let signalTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            scansObserved,
            new Promise<never>((_resolve, reject) => {
              signalTimer = setTimeout(
                () => reject(new Error("timed out waiting for tenant purge plan global scans")),
                5_000,
              );
            }),
          ]);
        } finally {
          if (signalTimer) clearTimeout(signalTimer);
        }

        let insertSettled = false;
        const [writerIdentity] = await writer.query<(RowDataPacket & {
          connection_id: number;
        })[]>("SELECT CONNECTION_ID() AS connection_id");
        const writerConnectionId = Number(writerIdentity[0]?.connection_id);
        expect(Number.isSafeInteger(writerConnectionId)).toBe(true);
        insertPending = writer.query(
          `INSERT INTO idempotency_keys
             (tenant_id, user_id, session_id, idem_key, request_hash, value, expires_at_ms)
           VALUES (?,?,?,?,NULL,NULL,?)`,
          [
            tenantId,
            source.session.userId,
            source.session.id,
            insertedKey,
            Date.now() + 60_000,
          ],
        ).then(() => {
          insertSettled = true;
        });
        await waitForIdempotencyLockWait(observer, database, writerConnectionId);
        expect(insertSettled).toBe(false);
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        await waitForIdempotencyLockWait(observer, database, writerConnectionId, 1_000);
        expect(insertSettled).toBe(false);

        releaseEvidence();
        const receipt = await sealPending;
        expect(receipt).toMatchObject({
          planEntryCount: TENANT_PURGE_PLAN_DOMAINS.length,
          planComplete: true,
        });
        await insertPending;
        expect(insertSettled).toBe(true);
        await writer.query(
          `DELETE FROM idempotency_keys
            WHERE tenant_id=? AND user_id=? AND session_id=? AND idem_key=?`,
          [tenantId, source.session.userId, source.session.id, insertedKey],
        );
      } finally {
        mutableStore.tenantPurgePlanTargetEvidence = originalTargetEvidence;
        releaseEvidence();
        await sealPending?.catch(() => {});
        await insertPending?.catch(() => {});
        await writer.query(
          "DELETE FROM idempotency_keys WHERE tenant_id=? AND idem_key=?",
          [tenantId, insertedKey],
        ).catch(() => {});
        await observer.end();
        await writer.end();
        await store.close();
      }
    });

    it("rejects a globally orphaned blob outbox before a page can advance", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-plan-page-orphan-${randomUUID()}`;
      try {
        const source = await advanceThroughT3c(
          store,
          tenantId,
          `page-orphan-user-${randomUUID()}`,
        );
        await store.materializeTenantPurgePlanJobs({ limit: 10 });
        const claim = await claimPlan(store, source.requestId);
        await conn.query(
          `INSERT INTO blob_delete_outbox
             (blob_id, generation, available_at_ms, attempts, created_at_ms)
           VALUES (?,1,NULL,0,?)`,
          [`blob_orphan_${randomUUID()}`, Date.now()],
        );

        await expect(store.buildTenantPurgePlanPage(
          planAuthorization(claim),
          { limit: 1 },
        )).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_purge_plan_entries WHERE request_id=?) AS entry_count,
             (SELECT COUNT(*) FROM tenant_purge_plan_receipts WHERE request_id=?) AS receipt_count,
             phase, scan_complete, plan_entry_count, cursor_domain
           FROM tenant_purge_plan_jobs WHERE request_id=?`,
          [source.requestId, source.requestId, source.requestId],
        );
        expect(Number(rows[0]?.entry_count)).toBe(0);
        expect(Number(rows[0]?.receipt_count)).toBe(0);
        expect(rows[0]).toMatchObject({
          phase: "queued",
          scan_complete: 0,
          plan_entry_count: 0,
          cursor_domain: null,
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rejects a globally orphaned lifecycle outbox before a complete page can seal", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-plan-seal-orphan-${randomUUID()}`;
      try {
        const source = await advanceThroughT3c(
          store,
          tenantId,
          `seal-orphan-user-${randomUUID()}`,
        );
        await store.materializeTenantPurgePlanJobs({ limit: 10 });
        const claim = await claimPlan(store, source.requestId);
        const authorization = planAuthorization(claim);
        expect((await store.buildTenantPurgePlanPage(
          authorization,
          { limit: TENANT_PURGE_PLAN_DOMAINS.length },
        )).done).toBe(true);
        const orphanSessionId = newId("sess");
        await conn.query(
          `INSERT INTO lifecycle_outbox
             (topic, aggregate_id, generation, payload, available_at_ms, attempts, created_at_ms)
           VALUES ('session.tombstoned',?,1,?,NULL,0,?)`,
          [
            orphanSessionId,
            JSON.stringify({
              sessionId: orphanSessionId,
              deletionGeneration: 1,
              eventSeq: 1,
            }),
            Date.now(),
          ],
        );

        await expect(store.sealTenantPurgePlan(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_purge_plan_entries WHERE request_id=?) AS entry_count,
             (SELECT COUNT(*) FROM tenant_purge_plan_receipts WHERE request_id=?) AS receipt_count,
             phase, scan_complete, plan_entry_count, aggregate_receipt_sha256, sealed_at_ms
           FROM tenant_purge_plan_jobs WHERE request_id=?`,
          [source.requestId, source.requestId, source.requestId],
        );
        expect(Number(rows[0]?.entry_count)).toBe(TENANT_PURGE_PLAN_DOMAINS.length);
        expect(Number(rows[0]?.receipt_count)).toBe(0);
        expect(rows[0]).toMatchObject({
          phase: "queued",
          scan_complete: 1,
          plan_entry_count: TENANT_PURGE_PLAN_DOMAINS.length,
          aggregate_receipt_sha256: null,
          sealed_at_ms: null,
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });
  });
}
