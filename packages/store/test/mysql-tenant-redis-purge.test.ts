import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type TenantRuntimeRevocationFleetProof,
} from "@agent-service/protocol";
import { TenantRedisPurgeWorker } from "../../core/src/index.js";
import { Redis } from "ioredis";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MysqlSessionStore,
  RedisSessionStatePurgeAdapter,
  TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
  TenantErasureIntegrityError,
  newErasureRequestId,
  redisSessionKeys,
  tenantErasureRequestHash,
  tenantRedisPurgeMarkerSha256,
  type RetentionPolicyDocumentV1,
  type TenantContentInventoryAuthorization,
  type TenantCredentialRevocationAuthorization,
  type TenantDatabasePurgeAuthorization,
  type TenantPurgeExecutionAuthorization,
  type TenantPurgePlanAuthorization,
  type TenantRedisPurgeAdapterResult,
  type TenantRedisPurgeAuthorization,
  type TenantRedisPurgeTarget,
  type TenantRuntimeRevocationAuthorization,
  type TenantRuntimeRevocationClaim,
} from "../src/index.js";
import { mkSession } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const REDIS_TEST_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379/1";
const REDIS_NAMESPACE_SHA256 = "7".repeat(64);

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

function policy(): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: 0,
    userErasureGraceMs: 0,
    operationalUsageRetentionMs: 0,
    idempotencyReceiptRetentionMs: 0,
    billingFactRetentionMs: 0,
    lifecycleAuditRetentionMs: 0,
    exportArtifactTtlMs: 60_000,
  };
}

async function installPolicy(store: MysqlSessionStore, tenantId: string): Promise<void> {
  const atMs = Date.now();
  await store.putRetentionPolicy({
    tenantId,
    policyVersion: "policy-v1",
    policy: policy(),
    actorKeyId: "redis-purge-policy-admin",
    atMs,
  });
  await store.activateRetentionPolicy({
    tenantId,
    policyVersion: "policy-v1",
    expectedControlGeneration: 0,
    actorKeyId: "redis-purge-policy-admin",
    atMs: atMs + 1,
  });
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

function inventoryAuthorization(
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

function executionAuthorization(
  claim: Awaited<ReturnType<MysqlSessionStore["claimTenantPurgeExecutions"]>>[number],
): TenantPurgeExecutionAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    planBuildGeneration: claim.planBuildGeneration,
    executionGeneration: claim.executionGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function databaseAuthorization(
  claim: Awaited<ReturnType<MysqlSessionStore["claimTenantDatabasePurges"]>>[number],
): TenantDatabasePurgeAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    planBuildGeneration: claim.planBuildGeneration,
    executionGeneration: claim.executionGeneration,
    databasePurgeGeneration: claim.databasePurgeGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function redisAuthorization(
  claim: Awaited<ReturnType<MysqlSessionStore["claimTenantRedisPurges"]>>[number],
): TenantRedisPurgeAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    planBuildGeneration: claim.planBuildGeneration,
    executionGeneration: claim.executionGeneration,
    databasePurgeGeneration: claim.databasePurgeGeneration,
    redisPurgeGeneration: claim.redisPurgeGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function fleetProof(claim: TenantRuntimeRevocationClaim): TenantRuntimeRevocationFleetProof {
  const body = {
    targetSha256: tenantRuntimeTargetSha256("http://mysql-redis-purge.internal:8080"),
    runnerId: "mysql-redis-purge-runner",
    bootId: "mysql-redis-purge-boot",
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

function redisResult(
  target: TenantRedisPurgeTarget,
  bits: { leaseExisted: boolean; fenceExisted: boolean; streamExisted: boolean } = {
    leaseExisted: true,
    fenceExisted: true,
    streamExisted: true,
  },
): TenantRedisPurgeAdapterResult {
  const evidence = {
    adapterProtocol: TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
    redisNamespaceSha256: target.redisNamespaceSha256,
    sessionId: target.sessionId,
    operationSha256: target.operationSha256,
    ...bits,
  };
  return {
    ...evidence,
    markerSha256: tenantRedisPurgeMarkerSha256(evidence),
    replayed: false,
  };
}

async function advanceToDatabaseReceipt(
  store: MysqlSessionStore,
  tenantId: string,
  sessionCount = 1,
  requestId = newErasureRequestId(),
): Promise<{ requestId: string; sessionIds: string[] }> {
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await installPolicy(store, tenantId);
  const sessions = Array.from({ length: sessionCount }, (_unused, index) => (
    mkSession(tenantId, `redis-user-${index}-${randomUUID()}`)
  ));
  for (const session of sessions) await store.createSession(session);

  if ((await store.readTenantCredentialTrackingCutover()).controlGeneration === 0) {
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
  }

  await store.requestTenantErasure({
    requestId,
    tenantId,
    requestedByKeyId: "redis-purge-lifecycle-admin",
    idempotencyKey: `redis-purge-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: Date.now(),
  });

  const credential = (await store.claimTenantCredentialRevocations({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `redis-credential-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!credential || !await store.revokeTenantCredentialMaterial(
    credentialAuthorization(credential),
  )) throw new Error("missing T3a completion");

  await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
  const runtime = (await store.claimTenantRuntimeRevocations({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `redis-runtime-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!runtime || !await store.completeTenantRuntimeRevocation(
    runtimeAuthorization(runtime),
    fleetProof(runtime),
  )) throw new Error("missing T3b completion");

  await store.materializeTenantContentInventoryJobs({ limit: 10 });
  const inventory = (await store.claimTenantContentInventories({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `redis-inventory-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!inventory) throw new Error("missing T3c claim");
  const inventoryAuth = inventoryAuthorization(inventory);
  let inventoryDone = false;
  while (!inventoryDone) {
    inventoryDone = (await store.buildTenantContentInventoryPage(
      inventoryAuth,
      { limit: 100 },
    )).done;
  }
  if (!await store.sealTenantContentInventory(inventoryAuth)) {
    throw new Error("missing T3c completion");
  }

  if (await store.materializeTenantPurgePlanJobs({ limit: 10 }) !== 1) {
    throw new Error("missing T3d materialization");
  }
  const plan = (await store.claimTenantPurgePlans({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `redis-plan-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!plan) throw new Error("missing T3d claim");
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  if (!await store.sealTenantPurgePlan(planAuthorization(plan))) {
    throw new Error("missing T3d completion");
  }

  if (await store.materializeTenantPurgeExecutionJobs({ limit: 10 }) !== 1) {
    throw new Error("missing T3e materialization");
  }
  const execution = (await store.claimTenantPurgeExecutions({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `redis-execution-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!execution) throw new Error("missing T3e claim");
  const executionAuth = executionAuthorization(execution);
  if (!await store.executeTenantPurgeLocalCutover(executionAuth)) {
    throw new Error("missing T3e cutover");
  }
  if (!await store.sealTenantPurgeLocalPhysicalAcks(executionAuth)) {
    throw new Error("missing T3e physical receipt");
  }

  if (await store.materializeTenantDatabasePurgeJobs({ limit: 10 }) !== 1) {
    throw new Error("missing T3f materialization");
  }
  const database = (await store.claimTenantDatabasePurges({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `redis-database-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!database) throw new Error("missing T3f claim");
  if (!await store.executeTenantDatabasePurge(databaseAuthorization(database))) {
    throw new Error("missing T3f completion");
  }
  return { requestId, sessionIds: sessions.map((session) => session.id) };
}

function restoreCursor(snapshotUpperBound: number, afterRestoreSeq: number): string {
  return Buffer.from(JSON.stringify([
    "tenant-redis-purge-restore-cursor-v2",
    snapshotUpperBound,
    afterRestoreSeq,
  ]), "utf8").toString("base64url");
}

async function waitForBlockedQuery(
  observer: Connection,
  fragments: string[],
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [rows] = await observer.query<RowDataPacket[]>("SHOW FULL PROCESSLIST");
    if (rows.some((row) => {
      const stateAndInfo = `${String(row.State ?? row.state ?? "")} ${String(
        row.Info ?? row.info ?? "",
      )}`;
      return fragments.every((fragment) => stateAndInfo.includes(fragment));
    })) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for blocked MySQL query: ${fragments.join(" / ")}`);
}

async function waitForRestoreSequenceLockWaiter(
  observer: Connection,
  database: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [rows] = await observer.query<(RowDataPacket & { waiters: number })[]>(
      `SELECT COUNT(DISTINCT waits.REQUESTING_ENGINE_TRANSACTION_ID) AS waiters
         FROM performance_schema.data_lock_waits waits
         JOIN performance_schema.data_locks requested
           ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
        WHERE requested.OBJECT_SCHEMA=?
          AND requested.OBJECT_NAME='tenant_redis_purge_restore_sequence'`,
      [database],
    );
    if (Number(rows[0]?.waiters ?? 0) > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the restore-sequence allocator row lock");
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant Redis purge", () => {
    let baseUrl: URL;
    let admin: Connection | undefined;
    let database = "";
    let mysqlUrl = "";
    let first: MysqlSessionStore;
    let second: MysqlSessionStore;
    let conn: Connection;

    beforeAll(async () => {
      baseUrl = assertDisposableTestTarget(BASE_MYSQL_URL);
      admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
    });

    beforeEach(async () => {
      database = `agent_service_redis_purge_test_${process.pid}_${randomUUID()
        .replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_redis_purge_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe tenant Redis purge test database name");
      }
      await admin!.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      mysqlUrl = databaseUrl(baseUrl, database);
      first = await MysqlSessionStore.connect({
        url: mysqlUrl,
        connectionLimit: 8,
        tenantRedisPurgeNamespaceSha256: REDIS_NAMESPACE_SHA256,
      });
      second = await MysqlSessionStore.connect({
        url: mysqlUrl,
        connectionLimit: 8,
        tenantRedisPurgeNamespaceSha256: REDIS_NAMESPACE_SHA256,
      });
      conn = await mysql.createConnection(mysqlUrl);
    });

    afterEach(async () => {
      await conn?.end();
      await first?.close();
      await second?.close();
      if (admin && database) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      database = "";
      mysqlUrl = "";
    });

    afterAll(async () => {
      await admin?.end();
    });

    it("reuses partial ACKs across claims, seals once, and keyset-restores across phase change", async () => {
      const tenantId = `tenant-redis-success-${randomUUID()}`;
      const source = await advanceToDatabaseReceipt(first, tenantId, 2);
      expect(await first.hasTenantRedisPurgeJobs()).toBe(false);
      expect(await first.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
      expect(await second.hasTenantRedisPurgeJobs()).toBe(true);

      const [leftClaims, rightClaims] = await Promise.all([
        first.claimTenantRedisPurges({ limit: 10, leaseMs: 120_000, claimToken: "redis-first" }),
        second.claimTenantRedisPurges({ limit: 10, leaseMs: 120_000, claimToken: "redis-racer" }),
      ]);
      const claims = [...leftClaims, ...rightClaims];
      expect(claims).toHaveLength(1);
      const firstAuth = redisAuthorization(claims[0]!);
      const targets = await first.getTenantRedisPurgeTargets(tenantId, source.requestId, 1);
      expect(targets.map((target) => target.sessionId).sort()).toEqual([...source.sessionIds].sort());

      const firstResult = redisResult(targets[0]!, {
        leaseExisted: true,
        fenceExisted: false,
        streamExisted: true,
      });
      const [firstAck, replayAck] = await Promise.all([
        first.recordTenantRedisPurgeTargetAck(firstAuth, firstResult),
        second.recordTenantRedisPurgeTargetAck(firstAuth, firstResult),
      ]);
      expect(replayAck).toEqual(firstAck);
      expect(await first.recordTenantRedisPurgeTargetAck(
        { ...firstAuth, tenantId: "foreign-tenant" },
        firstResult,
      )).toBeNull();

      const secondAck = await first.recordTenantRedisPurgeTargetAck(
        firstAuth,
        redisResult(targets[1]!, {
          leaseExisted: false,
          fenceExisted: true,
          streamExisted: false,
        }),
      );
      expect(secondAck).not.toBeNull();
      const partialPage = await first.listTenantRedisPurgeRestoreFences({ limit: 1 });
      expect(partialPage.fences).toHaveLength(1);
      expect(partialPage.fences[0]).toMatchObject({
        jobPhase: "queued",
        terminalReceiptSha256: null,
      });
      expect(partialPage.nextCursor).toBeDefined();

      expect(await first.retryTenantRedisPurge(firstAuth, {
        delayMs: 0,
        errorCode: "temporary_failure",
      })).toBe(true);
      const secondClaim = (await second.claimTenantRedisPurges({
        limit: 10,
        leaseMs: 120_000,
        claimToken: "redis-second",
      }))[0]!;
      const secondAuth = redisAuthorization(secondClaim);
      expect(await first.recordTenantRedisPurgeTargetAck(
        firstAuth,
        { ...firstResult, replayed: true },
      )).toBeNull();
      const reused = await second.recordTenantRedisPurgeTargetAck(
        secondAuth,
        { ...firstResult, replayed: true },
      );
      expect(reused).toEqual(firstAck);
      expect(reused?.completedClaimAttempt).toBe(firstAuth.claimAttempt);

      const receipt = await second.sealTenantRedisPurge(secondAuth);
      expect(receipt).toMatchObject({
        redisPurgeComplete: true,
        allDomainsComplete: false,
        contentPurgeExecuted: false,
        targetAckCount: 2,
        markerCount: 2,
        domainAckCount: 3,
        completedClaimAttempt: secondAuth.claimAttempt,
      });
      expect(await second.sealTenantRedisPurge(secondAuth)).toEqual(receipt);
      const resumed = await first.listTenantRedisPurgeRestoreFences({
        limit: 1,
        cursor: partialPage.nextCursor,
      });
      expect(resumed.fences).toHaveLength(1);
      expect(resumed.fences[0]).toMatchObject({
        jobPhase: "redis_purge_sealed",
        terminalReceiptSha256: receipt?.receiptSha256,
        targetAckReceiptSha256: secondAck?.receiptSha256,
      });
      expect(resumed.nextCursor).toBeUndefined();
      expect(await first.getTenantRedisPurgeJob("foreign-tenant", source.requestId)).toBeNull();
      expect(await first.getTenantRedisPurgeTargets("foreign-tenant", source.requestId, 1))
        .toEqual([]);
      await expect(first.listTenantRedisPurgeRestoreFences({
        limit: 1,
        cursor: restoreCursor(99, 99),
      })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    });

    it("freezes a restore scan by insertion sequence and picks up a later smaller request next scan", async () => {
      const highRequestId = "erase_f0000000-0000-4000-8000-000000000001";
      const highTenantId = `tenant-redis-restore-high-${randomUUID()}`;
      const high = await advanceToDatabaseReceipt(first, highTenantId, 2, highRequestId);
      expect(await first.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
      const highClaim = (await first.claimTenantRedisPurges({
        limit: 10,
        leaseMs: 120_000,
        claimToken: "redis-restore-high",
      })).find((candidate) => candidate.requestId === high.requestId)!;
      const highAuthorization = redisAuthorization(highClaim);
      const highTargets = await first.getTenantRedisPurgeTargets(
        highTenantId,
        high.requestId,
        1,
      );
      for (const target of highTargets) {
        expect(await first.recordTenantRedisPurgeTargetAck(
          highAuthorization,
          redisResult(target),
        )).not.toBeNull();
      }

      const lowRequestId = "erase_10000000-0000-4000-8000-000000000002";
      const lowTenantId = `tenant-redis-restore-low-${randomUUID()}`;
      const low = await advanceToDatabaseReceipt(first, lowTenantId, 1, lowRequestId);
      expect(low.requestId.localeCompare(high.requestId)).toBeLessThan(0);
      expect(await first.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
      const lowClaim = (await first.claimTenantRedisPurges({
        limit: 10,
        leaseMs: 120_000,
        claimToken: "redis-restore-low",
      })).find((candidate) => candidate.requestId === low.requestId)!;
      const [lowTarget] = await first.getTenantRedisPurgeTargets(lowTenantId, low.requestId, 1);
      await conn.beginTransaction();
      await conn.query(
        "SELECT next_restore_seq FROM tenant_redis_purge_restore_sequence WHERE singleton_id=1 FOR UPDATE",
      );
      const pendingLowAck = first.recordTenantRedisPurgeTargetAck(
        redisAuthorization(lowClaim),
        redisResult(lowTarget!),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const firstPage = await first.listTenantRedisPurgeRestoreFences({ limit: 1 });
      expect(firstPage.fences).toHaveLength(1);
      expect(firstPage.nextCursor).toBeDefined();
      await conn.rollback();
      expect(await pendingLowAck).not.toBeNull();
      const [restoreSequenceRows] = await conn.query<RowDataPacket[]>(
        "SELECT restore_seq FROM tenant_redis_purge_target_acks ORDER BY restore_seq",
      );
      expect(restoreSequenceRows.map((row) => Number(row.restore_seq))).toEqual([1, 2, 3]);

      const restOfFrozenScan = await first.listTenantRedisPurgeRestoreFences({
        limit: 10,
        cursor: firstPage.nextCursor,
      });
      expect(restOfFrozenScan.fences).toHaveLength(1);
      expect(restOfFrozenScan.fences[0]?.requestId).toBe(high.requestId);
      expect(restOfFrozenScan.nextCursor).toBeUndefined();

      const nextScan = await first.listTenantRedisPurgeRestoreFences({ limit: 10 });
      expect(nextScan.fences).toHaveLength(3);
      expect(nextScan.fences.filter((fence) => fence.requestId === low.requestId)).toHaveLength(1);
    });

    it("allocates restore sequence in commit order after the first ACK has inserted", async () => {
      const firstRequestId = "erase_f0000000-0000-4000-8000-000000000125";
      const secondRequestId = "erase_10000000-0000-4000-8000-000000000126";
      const firstTenantId = `tenant-redis-commit-first-${randomUUID()}`;
      const secondTenantId = `tenant-redis-commit-second-${randomUUID()}`;
      const firstSource = await advanceToDatabaseReceipt(
        first,
        firstTenantId,
        1,
        firstRequestId,
      );
      expect(await first.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
      const firstClaim = (await first.claimTenantRedisPurges({
        limit: 10,
        leaseMs: 120_000,
        claimToken: "redis-commit-first",
      })).find((candidate) => candidate.requestId === firstRequestId)!;
      const [firstTarget] = await first.getTenantRedisPurgeTargets(
        firstTenantId,
        firstSource.requestId,
        1,
      );

      const secondSource = await advanceToDatabaseReceipt(
        first,
        secondTenantId,
        1,
        secondRequestId,
      );
      expect(await first.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
      const secondClaim = (await second.claimTenantRedisPurges({
        limit: 10,
        leaseMs: 120_000,
        claimToken: "redis-commit-second",
      })).find((candidate) => candidate.requestId === secondRequestId)!;
      const [secondTarget] = await second.getTenantRedisPurgeTargets(
        secondTenantId,
        secondSource.requestId,
        1,
      );

      const [sequenceBeforeRows] = await conn.query<RowDataPacket[]>(
        "SELECT next_restore_seq FROM tenant_redis_purge_restore_sequence WHERE singleton_id=1",
      );
      const sequenceBefore = Number(sequenceBeforeRows[0]?.next_restore_seq);
      const gateName = `t3g_restore_${randomUUID().replaceAll("-", "")}`;
      if (!/^[a-z0-9_]{1,64}$/.test(gateName)) throw new Error("unsafe restore gate name");
      const triggerName = "trg_test_redis_ack_commit_pause";
      let gateHeld = false;
      let triggerCreated = false;
      let firstSettled = false;
      let secondSettled = false;
      let pendingFirst: Promise<unknown> | undefined;
      let pendingSecond: Promise<unknown> | undefined;
      try {
        const [gateRows] = await conn.query<RowDataPacket[]>(
          "SELECT GET_LOCK(?,5) AS acquired",
          [gateName],
        );
        expect(Number(gateRows[0]?.acquired)).toBe(1);
        gateHeld = true;
        await conn.query(
          `CREATE TRIGGER ${triggerName}
             AFTER INSERT ON tenant_redis_purge_target_acks FOR EACH ROW
           BEGIN
             DECLARE acquired INT DEFAULT NULL;
             DECLARE released INT DEFAULT NULL;
             IF NEW.request_id='${firstRequestId}' THEN
               IF NEW.restore_seq<>${sequenceBefore} THEN
                 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='unexpected allocated restore sequence';
               END IF;
               SET acquired=GET_LOCK('${gateName}',20);
               IF acquired IS NULL OR acquired<>1 THEN
                 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore sequence commit gate timed out';
               END IF;
               SET released=RELEASE_LOCK('${gateName}');
               IF released IS NULL OR released<>1 THEN
                 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='restore sequence commit gate release failed';
               END IF;
             END IF;
           END`,
        );
        triggerCreated = true;

        pendingFirst = first.recordTenantRedisPurgeTargetAck(
          redisAuthorization(firstClaim),
          redisResult(firstTarget!),
        ).finally(() => {
          firstSettled = true;
        });
        await waitForBlockedQuery(conn, ["User lock"]);
        expect(firstSettled).toBe(false);
        const [firstInvisibleRows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT next_restore_seq FROM tenant_redis_purge_restore_sequence
               WHERE singleton_id=1) AS next_restore_seq,
             (SELECT COUNT(*) FROM tenant_redis_purge_target_acks
               WHERE request_id IN (?,?)) AS ack_count`,
          [firstRequestId, secondRequestId],
        );
        expect(Number(firstInvisibleRows[0]?.next_restore_seq)).toBe(sequenceBefore);
        expect(Number(firstInvisibleRows[0]?.ack_count)).toBe(0);

        pendingSecond = second.recordTenantRedisPurgeTargetAck(
          redisAuthorization(secondClaim),
          redisResult(secondTarget!),
        ).finally(() => {
          secondSettled = true;
        });
        await waitForRestoreSequenceLockWaiter(conn, database);
        expect(firstSettled).toBe(false);
        expect(secondSettled).toBe(false);
        const [bothInvisibleRows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT next_restore_seq FROM tenant_redis_purge_restore_sequence
               WHERE singleton_id=1) AS next_restore_seq,
             (SELECT COUNT(*) FROM tenant_redis_purge_target_acks
               WHERE request_id IN (?,?)) AS ack_count`,
          [firstRequestId, secondRequestId],
        );
        expect(Number(bothInvisibleRows[0]?.next_restore_seq)).toBe(sequenceBefore);
        expect(Number(bothInvisibleRows[0]?.ack_count)).toBe(0);

        const [releaseRows] = await conn.query<RowDataPacket[]>(
          "SELECT RELEASE_LOCK(?) AS released",
          [gateName],
        );
        expect(Number(releaseRows[0]?.released)).toBe(1);
        gateHeld = false;
        await expect(pendingFirst).resolves.not.toBeNull();
        await expect(pendingSecond).resolves.not.toBeNull();

        const [committedRows] = await conn.query<RowDataPacket[]>(
          `SELECT request_id,restore_seq
             FROM tenant_redis_purge_target_acks
            WHERE request_id IN (?,?) ORDER BY restore_seq`,
          [firstRequestId, secondRequestId],
        );
        expect(committedRows.map((row) => ({
          requestId: String(row.request_id),
          restoreSeq: Number(row.restore_seq),
        }))).toEqual([
          { requestId: firstRequestId, restoreSeq: sequenceBefore },
          { requestId: secondRequestId, restoreSeq: sequenceBefore + 1 },
        ]);
        const [sequenceAfterRows] = await conn.query<RowDataPacket[]>(
          "SELECT next_restore_seq FROM tenant_redis_purge_restore_sequence WHERE singleton_id=1",
        );
        expect(Number(sequenceAfterRows[0]?.next_restore_seq)).toBe(sequenceBefore + 2);
      } finally {
        if (gateHeld) await conn.query("SELECT RELEASE_LOCK(?)", [gateName]).catch(() => {});
        await Promise.allSettled([pendingFirst, pendingSecond].filter(
          (pending): pending is Promise<unknown> => pending !== undefined,
        ));
        if (triggerCreated) await conn.query(`DROP TRIGGER ${triggerName}`).catch(() => {});
      }
    });

    it("keeps a durable job retryable across a temporary runner namespace mismatch", async () => {
      const firstTenantId = `tenant-redis-namespace-first-${randomUUID()}`;
      const firstSource = await advanceToDatabaseReceipt(first, firstTenantId);
      expect(await first.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
      const firstClaim = (await first.claimTenantRedisPurges({
        limit: 10,
        leaseMs: 120_000,
        claimToken: "redis-namespace-first",
      })).find((candidate) => candidate.requestId === firstSource.requestId)!;
      const [firstTarget] = await first.getTenantRedisPurgeTargets(
        firstTenantId,
        firstSource.requestId,
        1,
      );
      expect(await first.recordTenantRedisPurgeTargetAck(
        redisAuthorization(firstClaim),
        redisResult(firstTarget!),
      )).not.toBeNull();
      expect(await first.sealTenantRedisPurge(redisAuthorization(firstClaim))).not.toBeNull();

      const retryTenantId = `tenant-redis-namespace-retry-${randomUUID()}`;
      const retrySource = await advanceToDatabaseReceipt(first, retryTenantId);
      expect(await first.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);

      const misconfigured = await MysqlSessionStore.connect({
        url: mysqlUrl,
        connectionLimit: 2,
        tenantRedisPurgeNamespaceSha256: "8".repeat(64),
      });
      try {
        expect(await misconfigured.claimTenantRedisPurges({
          limit: 10,
          leaseMs: 120_000,
          claimToken: "redis-namespace-wrong",
        })).toEqual([]);
      } finally {
        await misconfigured.close();
      }
      expect(await first.getTenantRedisPurgeJob(retryTenantId, retrySource.requestId))
        .toMatchObject({ phase: "queued", attempts: 0 });

      const recoveredClaim = (await first.claimTenantRedisPurges({
        limit: 10,
        leaseMs: 120_000,
        claimToken: "redis-namespace-corrected",
      })).find((candidate) => candidate.requestId === retrySource.requestId);
      expect(recoveredClaim).toBeDefined();
      const [retryTarget] = await first.getTenantRedisPurgeTargets(
        retryTenantId,
        retrySource.requestId,
        1,
      );
      expect(await first.recordTenantRedisPurgeTargetAck(
        redisAuthorization(recoveredClaim!),
        redisResult(retryTarget!),
      )).not.toBeNull();
      expect(await first.sealTenantRedisPurge(redisAuthorization(recoveredClaim!)))
        .not.toBeNull();
    });

    it("isolates due namespace-poisoned jobs while still claiming a healthy neighbor", async () => {
      const expiredRequestId = "erase_10000000-0000-4000-8000-000000000025";
      const unclaimedRequestId = "erase_20000000-0000-4000-8000-000000000025";
      const seedRequestId = "erase_30000000-0000-4000-8000-000000000025";
      const healthyRequestId = "erase_40000000-0000-4000-8000-000000000025";
      const wrongNamespace = "8".repeat(64);
      const misconfigured = await MysqlSessionStore.connect({
        url: mysqlUrl,
        connectionLimit: 2,
        tenantRedisPurgeNamespaceSha256: wrongNamespace,
      });
      try {
        const expiredTenantId = `tenant-redis-poison-expired-${randomUUID()}`;
        const expired = await advanceToDatabaseReceipt(
          first,
          expiredTenantId,
          1,
          expiredRequestId,
        );
        expect(await misconfigured.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);

        const unclaimedTenantId = `tenant-redis-poison-unclaimed-${randomUUID()}`;
        await advanceToDatabaseReceipt(
          first,
          unclaimedTenantId,
          1,
          unclaimedRequestId,
        );
        expect(await misconfigured.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
        const [expiringClaim] = await misconfigured.claimTenantRedisPurges({
          limit: 1,
          leaseMs: 1,
          claimToken: "redis-poison-expired",
        });
        expect(expiringClaim?.requestId).toBe(expired.requestId);

        const seedTenantId = `tenant-redis-poison-seed-${randomUUID()}`;
        const seed = await advanceToDatabaseReceipt(first, seedTenantId, 1, seedRequestId);
        expect(await first.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
        const seedClaim = (await first.claimTenantRedisPurges({
          limit: 10,
          leaseMs: 120_000,
          claimToken: "redis-poison-seed",
        })).find((candidate) => candidate.requestId === seed.requestId)!;
        const [seedTarget] = await first.getTenantRedisPurgeTargets(
          seedTenantId,
          seed.requestId,
          1,
        );
        expect(await first.recordTenantRedisPurgeTargetAck(
          redisAuthorization(seedClaim),
          redisResult(seedTarget!),
        )).not.toBeNull();
        expect(await first.sealTenantRedisPurge(redisAuthorization(seedClaim))).not.toBeNull();

        const healthyTenantId = `tenant-redis-poison-healthy-${randomUUID()}`;
        const healthy = await advanceToDatabaseReceipt(
          first,
          healthyTenantId,
          1,
          healthyRequestId,
        );
        expect(await first.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));

        const claims = await first.claimTenantRedisPurges({
          limit: 10,
          leaseMs: 120_000,
          claimToken: "redis-poison-healthy",
        });
        expect(claims.map((claim) => claim.requestId)).toEqual([healthy.requestId]);
        const [poisonedRows] = await conn.query<RowDataPacket[]>(
          `SELECT request_id,phase,attempts,claim_token,lease_until_ms,blocked_reason_code
             FROM tenant_redis_purge_jobs
            WHERE request_id IN (?,?) ORDER BY request_id`,
          [expiredRequestId, unclaimedRequestId],
        );
        expect(poisonedRows.map((row) => ({
          requestId: String(row.request_id),
          phase: String(row.phase),
          attempts: Number(row.attempts),
          claimToken: row.claim_token,
          leaseUntilMs: row.lease_until_ms,
          blockedReasonCode: String(row.blocked_reason_code),
        }))).toEqual([
          {
            requestId: expiredRequestId,
            phase: "blocked",
            attempts: 2,
            claimToken: null,
            leaseUntilMs: null,
            blockedReasonCode: "integrity_conflict",
          },
          {
            requestId: unclaimedRequestId,
            phase: "blocked",
            attempts: 1,
            claimToken: null,
            leaseUntilMs: null,
            blockedReasonCode: "integrity_conflict",
          },
        ]);
      } finally {
        await misconfigured.close();
      }
    });

    it("recovers the Redis-commit/MySQL-ACK crash window with the gate closed and restores durable fences", async () => {
      const tenantId = `tenant-redis-cross-store-${randomUUID()}`;
      const source = await advanceToDatabaseReceipt(first, tenantId);
      expect(await first.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
      const claim = (await first.claimTenantRedisPurges({
        limit: 10,
        leaseMs: 1,
        claimToken: "redis-cross-store-crashed",
      })).find((candidate) => candidate.requestId === source.requestId)!;
      const [target] = await first.getTenantRedisPurgeTargets(
        tenantId,
        source.requestId,
        1,
      );
      const prefix = `cross-store-${randomUUID()}`;
      const keys = redisSessionKeys(target!.sessionId, prefix);
      const redis = new Redis(REDIS_TEST_URL);
      const adapter = new RedisSessionStatePurgeAdapter(REDIS_TEST_URL, {
        prefix,
        namespaceSha256: REDIS_NAMESPACE_SHA256,
      });
      const gate = vi.fn().mockResolvedValue(false);
      const worker = new TenantRedisPurgeWorker({
        store: second,
        adapter,
        canExecute: gate,
      }, {
        leaseMs: 120_000,
        restoreIntervalMs: 120_000,
      });
      try {
        await redis.hset(keys.lease, "owner", "runner-before-crash", "fence", "9");
        await redis.set(keys.fence, "9");
        await redis.xadd(keys.stream, "*", "seq", "1", "e", "before-crash");

        // The Lua transaction committed, but the process died before it could publish the MySQL
        // ACK. This is the only cross-store gap in the saga and must not require reopening the
        // destructive fleet gate merely to finish already-authorized work.
        const firstResult = await adapter.purgeSessionState({
          sessionId: target!.sessionId,
          operationSha256: target!.operationSha256,
        });
        expect(await first.getTenantRedisPurgeTargetAcks(tenantId, source.requestId, 1))
          .toEqual([]);

        // A stale pre-marker writer can race after the first delete. Existing-marker-only replay
        // must atomically remove these keys while preserving the first existence bits.
        await redis.hset(keys.lease, "owner", "stale-runner", "fence", "10");
        await redis.set(keys.fence, "10");
        await redis.xadd(keys.stream, "*", "seq", "2", "e", "after-marker");
        await new Promise<void>((resolve) => setTimeout(resolve, 10));

        expect(await worker.processOnce()).toBe(1);
        expect(gate).toHaveBeenCalledOnce();
        expect(await redis.exists(keys.lease, keys.fence, keys.stream)).toBe(0);
        expect(await adapter.inspectSessionPurge({
          sessionId: target!.sessionId,
          operationSha256: target!.operationSha256,
        })).toEqual({ ...firstResult, replayed: true });
        expect(await first.getTenantRedisPurgeReceipt(tenantId, source.requestId))
          .toMatchObject({
            redisPurgeComplete: true,
            targetAckCount: 1,
            markerCount: 1,
            completedClaimAttempt: 2,
          });

        // After a Redis restore loses both marker and deleted-key state, the durable ACK is the
        // authority for recreating the exact marker and deleting any resurrected live domains.
        await redis.del(keys.purgeMarker);
        await redis.set(keys.fence, "restored-stale-state");
        expect(await worker.replayDurableRestoreFences()).toBe(1);
        expect(await redis.exists(keys.lease, keys.fence, keys.stream)).toBe(0);
        expect(await adapter.inspectSessionPurge({
          sessionId: target!.sessionId,
          operationSha256: target!.operationSha256,
        })).toEqual({ ...firstResult, replayed: true });
      } finally {
        await redis.del(keys.lease, keys.fence, keys.stream, keys.purgeMarker);
        await adapter.close();
        await redis.quit();
      }
    });

    it("rolls back job publication, target ACK publication, and terminal seal failures", async () => {
      const tenantId = `tenant-redis-rollback-${randomUUID()}`;
      const source = await advanceToDatabaseReceipt(first, tenantId);

      await conn.query(
        `CREATE TRIGGER trg_test_redis_target_insert_fail
           BEFORE INSERT ON tenant_redis_purge_targets
           FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected target failure'`,
      );
      await expect(first.materializeTenantRedisPurgeJobs({ limit: 10 }))
        .rejects.toThrow(/injected target failure/i);
      expect(await first.hasTenantRedisPurgeJobs()).toBe(false);
      await conn.query("DROP TRIGGER trg_test_redis_target_insert_fail");
      expect(await first.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);

      const claim = (await first.claimTenantRedisPurges({
        limit: 10,
        leaseMs: 120_000,
        claimToken: "redis-rollback",
      }))[0]!;
      const auth = redisAuthorization(claim);
      const [target] = await first.getTenantRedisPurgeTargets(tenantId, source.requestId, 1);
      const result = redisResult(target!);

      await expect(conn.query(
        `UPDATE tenant_redis_purge_jobs
            SET attempts=attempts+1, claim_token='redis-illegal-live-takeover',
                lease_until_ms=lease_until_ms+1000
          WHERE request_id=?`,
        [source.requestId],
      )).rejects.toThrow(/job update is not permitted/i);

      const [sequenceBeforeRows] = await conn.query<RowDataPacket[]>(
        "SELECT next_restore_seq FROM tenant_redis_purge_restore_sequence WHERE singleton_id=1",
      );
      const sequenceBefore = Number(sequenceBeforeRows[0]?.next_restore_seq);
      await conn.query(
        `CREATE TRIGGER trg_test_redis_ack_insert_fail
           AFTER INSERT ON tenant_redis_purge_target_acks
           FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected ACK failure'`,
      );
      await expect(first.recordTenantRedisPurgeTargetAck(auth, result))
        .rejects.toThrow(/injected ACK failure/i);
      expect(await first.getTenantRedisPurgeTargetAcks(tenantId, source.requestId, 1)).toEqual([]);
      expect(await first.getTenantRedisPurgeJob(tenantId, source.requestId)).toMatchObject({
        phase: "queued",
        targetAckCount: 0,
        markerCount: 0,
      });
      const [sequenceRollbackRows] = await conn.query<RowDataPacket[]>(
        "SELECT next_restore_seq FROM tenant_redis_purge_restore_sequence WHERE singleton_id=1",
      );
      expect(Number(sequenceRollbackRows[0]?.next_restore_seq)).toBe(sequenceBefore);
      await conn.query("DROP TRIGGER trg_test_redis_ack_insert_fail");
      const ack = await first.recordTenantRedisPurgeTargetAck(auth, result);
      expect(ack).not.toBeNull();
      const [restoredSequenceRows] = await conn.query<RowDataPacket[]>(
        `SELECT restore_seq,
                (SELECT next_restore_seq FROM tenant_redis_purge_restore_sequence
                  WHERE singleton_id=1) AS next_restore_seq
           FROM tenant_redis_purge_target_acks WHERE request_id=?`,
        [source.requestId],
      );
      expect(Number(restoredSequenceRows[0]?.restore_seq)).toBe(sequenceBefore);
      expect(Number(restoredSequenceRows[0]?.next_restore_seq)).toBe(sequenceBefore + 1);

      await conn.query(
        `CREATE TRIGGER trg_test_redis_domain_insert_fail
           BEFORE INSERT ON tenant_redis_purge_domain_acks
           FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected seal failure'`,
      );
      await expect(first.sealTenantRedisPurge(auth)).rejects.toThrow(/injected seal failure/i);
      expect(await first.getTenantRedisPurgeDomainAcks(tenantId, source.requestId, 1)).toEqual([]);
      expect(await first.getTenantRedisPurgeReceipt(tenantId, source.requestId)).toBeNull();
      expect(await first.getTenantRedisPurgeJob(tenantId, source.requestId)).toMatchObject({
        phase: "queued",
        targetAckCount: 1,
        markerCount: 1,
      });
      const [partialFence] = (await first.listTenantRedisPurgeRestoreFences({ limit: 10 })).fences;
      expect(partialFence).toMatchObject({
        jobPhase: "queued",
        terminalReceiptSha256: null,
        markerSha256: result.markerSha256,
      });
      await conn.query("DROP TRIGGER trg_test_redis_domain_insert_fail");
      expect(await first.sealTenantRedisPurge(auth)).not.toBeNull();
    });

    it("restores blocked partial evidence and fails closed on durable ACK corruption", async () => {
      const tenantId = `tenant-redis-blocked-${randomUUID()}`;
      const source = await advanceToDatabaseReceipt(first, tenantId);
      expect(await first.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
      const claim = (await first.claimTenantRedisPurges({
        limit: 10,
        leaseMs: 120_000,
        claimToken: "redis-blocked",
      }))[0]!;
      const auth = redisAuthorization(claim);
      const [target] = await first.getTenantRedisPurgeTargets(tenantId, source.requestId, 1);
      const result = redisResult(target!, {
        leaseExisted: false,
        fenceExisted: true,
        streamExisted: true,
      });
      await first.recordTenantRedisPurgeTargetAck(auth, result);
      expect(await first.blockTenantRedisPurge(auth)).toBe(true);
      const [blockedFence] = (await second.listTenantRedisPurgeRestoreFences({ limit: 10 })).fences;
      expect(blockedFence).toMatchObject({
        jobPhase: "blocked",
        terminalReceiptSha256: null,
        markerSha256: result.markerSha256,
      });

      await conn.query("DROP TRIGGER trg_tenant_redis_purge_target_acks_bu");
      await conn.query(
        `UPDATE tenant_redis_purge_target_acks
            SET marker_sha256=REPEAT('f',64) WHERE request_id=?`,
        [source.requestId],
      );
      await expect(first.listTenantRedisPurgeRestoreFences({ limit: 10 }))
        .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    });
  });
}
