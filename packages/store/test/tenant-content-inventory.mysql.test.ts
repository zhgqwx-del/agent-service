import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  emptyUsage,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type Approval,
  type Item,
  type TenantRuntimeRevocationFleetProof,
  type Turn,
} from "@agent-service/protocol";
import mysql, { type Connection, type Pool, type RowDataPacket } from "mysql2/promise";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  MysqlSessionStore,
  TenantContentInventoryEvidenceChangedError,
  TenantContentInventoryNotReadyError,
  TenantErasureIntegrityError,
  newErasureRequestId,
  tenantSessionContentReceiptSha256,
  tenantErasureRequestHash,
  type RetentionPolicyDocumentV1,
  type TenantContentInventoryAuthorization,
  type TenantCredentialRevocationAuthorization,
  type TenantRuntimeRevocationAuthorization,
  type TenantRuntimeRevocationClaim,
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

function policy(contentRetentionMs: number | null): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: contentRetentionMs,
    userErasureGraceMs: 0,
    operationalUsageRetentionMs: null,
    idempotencyReceiptRetentionMs: null,
    billingFactRetentionMs: null,
    lifecycleAuditRetentionMs: null,
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

function fleetProof(claim: TenantRuntimeRevocationClaim): TenantRuntimeRevocationFleetProof {
  const body = {
    targetSha256: tenantRuntimeTargetSha256("http://mysql-content-runner.internal:8080"),
    runnerId: "mysql-content-runner",
    bootId: "mysql-content-boot",
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
  contentRetentionMs: number | null,
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

async function createRichSession(
  store: MysqlSessionStore,
  tenantId: string,
  userId: string,
  parentSessionId?: string,
) {
  const session = {
    ...mkSession(tenantId, userId),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
  };
  await store.createSession(session);
  const turn: Turn = {
    id: newId("turn"),
    sessionId: session.id,
    status: "inProgress",
    seqStart: 2,
    steps: 1,
    toolCalls: 0,
    usage: emptyUsage(),
    startedAtMs: Date.now(),
  };
  const approvalId = newId("apr");
  const item: Item = {
    id: newId("item"),
    sessionId: session.id,
    turnId: turn.id,
    seq: 0,
    step: 1,
    status: "completed",
    createdAtMs: Date.now(),
    completedAtMs: Date.now(),
    type: "approvalRequest",
    approvalId,
    toolCallId: "private-tool-call",
    name: "private-tool",
    args: { secret: "never-in-receipt" },
  };
  const approval: Approval = {
    id: approvalId,
    sessionId: session.id,
    turnId: turn.id,
    // Keep the historical field intentionally different: approvalRequest.approvalId is the
    // canonical durable association.
    itemId: newId("item"),
    status: "pending",
    toolCallId: "private-tool-call",
    toolName: "private-tool",
    args: { secret: "never-in-receipt" },
    availableDecisions: ["accept", "decline"],
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  };
  await store.commit({
    sessionId: session.id,
    fence: 1,
    turn,
    items: [item],
    approvals: [approval],
    events: [
      { type: "turn/started", sessionId: session.id, emittedAtMs: Date.now(), turn },
      { type: "item/completed", sessionId: session.id, emittedAtMs: Date.now(), item },
      { type: "approval/requested", sessionId: session.id, emittedAtMs: Date.now(), approval },
    ],
  });
  return { session, turn, item, approval };
}

async function createEvolvedSession(
  store: MysqlSessionStore,
  tenantId: string,
  userId: string,
) {
  const session = mkSession(tenantId, userId);
  await store.createSession(session);
  const atMs = Date.now();
  const turn: Turn = {
    id: newId("turn"),
    sessionId: session.id,
    status: "inProgress",
    seqStart: 2,
    steps: 1,
    toolCalls: 0,
    usage: emptyUsage(),
    startedAtMs: atMs,
  };
  const approvalId = newId("apr");
  const item: Item = {
    id: newId("item"),
    sessionId: session.id,
    turnId: turn.id,
    seq: 0,
    step: 1,
    status: "inProgress",
    createdAtMs: atMs,
    type: "approvalRequest",
    approvalId,
    toolCallId: "normal-tool-call",
    name: "normal-tool",
    args: {},
  };
  const approval: Approval = {
    id: approvalId,
    sessionId: session.id,
    turnId: turn.id,
    itemId: newId("item"),
    status: "pending",
    toolCallId: "normal-tool-call",
    toolName: "normal-tool",
    args: {},
    availableDecisions: ["accept", "decline"],
    createdAtMs: atMs,
    expiresAtMs: atMs + 60_000,
  };
  await store.commit({
    sessionId: session.id,
    fence: 1,
    turn,
    items: [item],
    approvals: [approval],
    events: [
      { type: "turn/started", sessionId: session.id, emittedAtMs: atMs, turn },
      { type: "item/started", sessionId: session.id, emittedAtMs: atMs, item },
      { type: "approval/requested", sessionId: session.id, emittedAtMs: atMs, approval },
    ],
  });
  const completedAtMs = atMs + 1;
  const completedItem: Item = {
    ...item,
    status: "completed",
    completedAtMs,
  };
  const resolvedApproval: Approval = {
    ...approval,
    status: "resolved",
    decision: "accept",
    decidedBy: "normal-operator",
    resolvedAtMs: completedAtMs,
  };
  const completedTurn: Turn = {
    ...turn,
    status: "completed",
    stopReason: "end_turn",
    completedAtMs,
  };
  await store.commit({
    sessionId: session.id,
    fence: 1,
    turn: completedTurn,
    items: [completedItem],
    approvals: [resolvedApproval],
    events: [
      {
        type: "item/completed",
        sessionId: session.id,
        emittedAtMs: completedAtMs,
        item: completedItem,
      },
      {
        type: "approval/resolved",
        sessionId: session.id,
        emittedAtMs: completedAtMs,
        approval: resolvedApproval,
      },
      {
        type: "turn/completed",
        sessionId: session.id,
        emittedAtMs: completedAtMs,
        turn: completedTurn,
        stopReason: "end_turn",
      },
    ],
  });
  return { session, turn: completedTurn, item: completedItem, approval: resolvedApproval };
}

async function createStandaloneCompaction(
  store: MysqlSessionStore,
  tenantId: string,
  userId: string,
) {
  const session = mkSession(tenantId, userId);
  await store.createSession(session);
  const atMs = Date.now();
  const item: Item = {
    id: newId("item"),
    sessionId: session.id,
    turnId: newId("turn"),
    seq: 0,
    status: "completed",
    createdAtMs: atMs,
    completedAtMs: atMs,
    type: "contextCompaction",
    replacesUpToSeq: 1,
    summary: "private compaction summary",
    usageSnapshot: emptyUsage(),
  };
  await store.commit({
    sessionId: session.id,
    fence: 1,
    items: [item],
    events: [
      { type: "item/completed", sessionId: session.id, emittedAtMs: atMs, item },
      { type: "session/compacted", sessionId: session.id, emittedAtMs: atMs, itemId: item.id },
    ],
    sessionPatch: { lastCompactionSeq: 1 },
  });
  return { session, item };
}

async function advanceThroughT3b(
  store: MysqlSessionStore,
  tenantId: string,
  contentRetentionMs: number,
): Promise<{ requestId: string }> {
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await installPolicy(store, tenantId, contentRetentionMs);
  const request = {
    requestId: newErasureRequestId(),
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey: `content-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: Date.now(),
  };
  await store.requestTenantErasure(request);
  const credential = (await store.claimTenantCredentialRevocations({
    limit: 10,
    leaseMs: 60_000,
    claimToken: `credential-${randomUUID()}`,
  })).find((claim) => claim.requestId === request.requestId);
  expect(credential).toBeDefined();
  expect(await store.revokeTenantCredentialMaterial(credentialAuthorization(credential!)))
    .not.toBeNull();
  expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 10 })).toBe(1);
  const runtime = (await store.claimTenantRuntimeRevocations({
    limit: 10,
    leaseMs: 60_000,
    claimToken: `runtime-${randomUUID()}`,
  })).find((claim) => claim.requestId === request.requestId);
  expect(runtime).toBeDefined();
  expect(await store.completeTenantRuntimeRevocation(
    runtimeAuthorization(runtime!),
    fleetProof(runtime!),
  )).not.toBeNull();
  return { requestId: request.requestId };
}

async function databaseNow(conn: Connection): Promise<number> {
  const [rows] = await conn.query<(RowDataPacket & { now_ms: number })[]>(
    "SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS now_ms",
  );
  const value = Number(rows[0]?.now_ms);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid test database clock");
  return value;
}

async function withForcedStoreDatabaseNow<T>(
  store: MysqlSessionStore,
  timestampMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  const mutableClock = store as unknown as {
    databaseNow(connection: unknown): Promise<number>;
  };
  const originalDatabaseNow = mutableClock.databaseNow;
  mutableClock.databaseNow = async () => timestampMs;
  try {
    return await operation();
  } finally {
    mutableClock.databaseNow = originalDatabaseNow;
  }
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
      const info = String(row.Info ?? row.info ?? "");
      const state = String(row.State ?? row.state ?? "");
      return fragments.every((fragment) => (
        info.includes(fragment) || state.includes(fragment)
      ));
    })) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for blocked MySQL query: ${fragments.join(" / ")}`);
}

async function setStoreSessionsReadCommitted(
  store: MysqlSessionStore,
  connectionCount: number,
): Promise<void> {
  // Check out the complete small test pool at once so every session used by seal has the intended
  // default. This avoids changing the MySQL server global shared by parallel test files.
  const pool = (store as unknown as { pool: Pool }).pool;
  const connections = [];
  try {
    for (let index = 0; index < connectionCount; index += 1) {
      connections.push(await pool.getConnection());
    }
    for (const conn of connections) {
      await conn.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
      const [rows] = await conn.query<RowDataPacket[]>(
        "SELECT @@SESSION.transaction_isolation AS isolation_level",
      );
      expect(String(rows[0]?.isolation_level)).toBe("READ-COMMITTED");
    }
  } finally {
    for (const conn of connections) conn.release();
  }
}

async function waitUntilDatabaseTimePasses(
  conn: Connection,
  timestampMs: number,
): Promise<void> {
  while (await databaseNow(conn) <= timestampMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant content inventory", () => {
    let baseUrl: URL;
    let admin: Connection | undefined;
    let database = "";
    let mysqlUrl = "";

    beforeAll(async () => {
      baseUrl = assertDisposableTestTarget(BASE_MYSQL_URL);
      admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
    });

    beforeEach(async () => {
      database = `agent_service_content_test_${process.pid}_${randomUUID()
        .replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_content_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe tenant content inventory test database name");
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

    it("anchors on DB time, scans paginated owner content, and replays only exact content-free proof", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-content-success-${randomUUID()}`;
      const userId = `private-user-${randomUUID()}`;
      try {
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(store, tenantId, 0);
        const first = await createRichSession(store, tenantId, userId);
        const second = { ...mkSession(tenantId, userId), parentSessionId: first.session.id };
        await store.createSession(second);
        const neighbor = { ...mkSession(`neighbor-${randomUUID()}`, "neighbor-user") };
        await store.createSession(neighbor);
        const source = await advanceThroughExistingPolicyT3b(store, tenantId);
        const beforeDbMs = await databaseNow(conn);
        expect(await store.materializeTenantContentInventoryJobs({ limit: 10 })).toBe(1);
        const afterDbMs = await databaseNow(conn);
        expect(await store.materializeTenantContentInventoryJobs({ limit: 10 })).toBe(0);
        const job = await store.getTenantContentInventoryJob(tenantId, source.requestId);
        expect(job).toMatchObject({
          phase: "queued",
          contentNotBeforeDbMs: job!.retentionAnchorDbMs,
          sessionReceiptCount: 0,
        });
        expect(job!.retentionAnchorDbMs).toBeGreaterThanOrEqual(beforeDbMs);
        expect(job!.retentionAnchorDbMs).toBeLessThanOrEqual(afterDbMs);

        const [claim] = await store.claimTenantContentInventories({
          limit: 1,
          leaseMs: 60_000,
          claimToken: `inventory-${randomUUID()}`,
        });
        const authorization = inventoryAuthorization(claim!);
        expect(await store.buildTenantContentInventoryPage(authorization, { limit: 1 }))
          .toMatchObject({ built: 1, done: false, sessionReceiptCount: 1 });
        expect(await store.buildTenantContentInventoryPage(authorization, { limit: 1 }))
          .toMatchObject({ built: 1, done: true, sessionReceiptCount: 2 });
        const receipts = await store.getTenantSessionContentReceipts(
          tenantId,
          source.requestId,
          1,
        );
        expect(receipts).toHaveLength(2);
        expect(receipts.reduce((sum, receipt) => sum + receipt.contentRecordCount, 0)).toBe(10);
        const serialized = JSON.stringify(receipts);
        expect(serialized).not.toContain(userId);
        expect(serialized).not.toContain("private-body");
        expect(serialized).not.toContain("private-tool");
        expect(serialized).not.toContain(authorization.claimToken);

        const aggregate = await store.sealTenantContentInventory(authorization);
        expect(aggregate).toMatchObject({
          tenantId,
          sessionReceiptCount: 2,
          contentRecordCount: 10,
          globalOrphanCheck: "passed",
          contentInventoryComplete: true,
          contentPurgeExecuted: false,
        });
        expect(await store.sealTenantContentInventory(authorization)).toEqual(aggregate);
        expect(await store.sealTenantContentInventory({
          ...authorization,
          claimToken: `different-${randomUUID()}`,
        })).toBeNull();
        expect(await store.getTenantContentInventoryReceipt(tenantId, source.requestId))
          .toEqual(aggregate);
        expect(await store.getTenantContentInventoryReceipt(
          neighbor.tenantId,
          source.requestId,
        )).toBeNull();
        expect(await store.getTenantSessionContentReceipts(
          neighbor.tenantId,
          source.requestId,
          1,
        )).toEqual([]);

        const [sourceCounts] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM sessions WHERE tenant_id=?) AS sessions,
             (SELECT COUNT(*) FROM turns WHERE session_id=?) AS turns,
             (SELECT COUNT(*) FROM items WHERE session_id=?) AS items,
             (SELECT COUNT(*) FROM events WHERE session_id=?) AS events,
             (SELECT COUNT(*) FROM approvals WHERE session_id=?) AS approvals`,
          [tenantId, first.session.id, first.session.id, first.session.id, first.session.id],
        );
        expect(sourceCounts[0]).toMatchObject({
          sessions: 2,
          turns: 1,
          items: 1,
          events: 4,
          approvals: 1,
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("accepts normal started-to-completed and requested-to-resolved history", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const tenantId = `tenant-content-history-${randomUUID()}`;
      try {
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(store, tenantId, 0);
        await createEvolvedSession(store, tenantId, "history-user");
        const source = await advanceThroughExistingPolicyT3b(store, tenantId);
        expect(await store.materializeTenantContentInventoryJobs({ limit: 10 })).toBe(1);
        const claim = (await store.claimTenantContentInventories({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `history-${randomUUID()}`,
        })).find((candidate) => candidate.requestId === source.requestId)!;
        const authorization = inventoryAuthorization(claim);
        expect(await store.buildTenantContentInventoryPage(authorization, { limit: 10 }))
          .toMatchObject({ built: 1, done: true });
        expect(await store.sealTenantContentInventory(authorization))
          .toMatchObject({ tenantId, contentInventoryComplete: true });
      } finally {
        await store.close();
      }
    });

    it("waits for the maximum T3a/T3b DB clock while committing a healthy neighbor", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      try {
        const initialNow = await databaseNow(conn);
        const highT3bMs = initialNow + 10_000;
        const highT3bTenant = `tenant-content-high-t3b-${randomUUID()}`;
        await store.setTenantAuth(highT3bTenant, DEFAULT_AUTH_POLICY);
        await installPolicy(store, highT3bTenant, 0);
        const highT3b = await advanceThroughExistingPolicyT3b(
          store,
          highT3bTenant,
          "erase_00000000-0000-4000-8000-000000000031",
          { runtimeCompletionMs: highT3bMs },
        );

        const healthyTenant = `tenant-content-clock-neighbor-${randomUUID()}`;
        await store.setTenantAuth(healthyTenant, DEFAULT_AUTH_POLICY);
        await installPolicy(store, healthyTenant, 0);
        const healthy = await advanceThroughExistingPolicyT3b(
          store,
          healthyTenant,
          "erase_ffffffff-ffff-4fff-bfff-fffffffffff3",
        );

        await expect(store.materializeTenantContentInventoryJobs({ limit: 1 }))
          .rejects.toMatchObject({ reason: "trusted_clock_before_source" });
        const [neighborRows] = await conn.query<RowDataPacket[]>(
          `SELECT request_id, tenant_id, phase
             FROM tenant_content_inventory_jobs ORDER BY request_id`,
        );
        expect(neighborRows).toEqual([expect.objectContaining({
          request_id: healthy.requestId,
          tenant_id: healthyTenant,
          phase: "queued",
        })]);
        expect(neighborRows.some((row) => row.request_id === highT3b.requestId)).toBe(false);
        const claims = await store.claimTenantContentInventories({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `clock-neighbor-${randomUUID()}`,
        });
        expect(claims.map((claim) => claim.requestId)).toEqual([healthy.requestId]);

        expect(await withForcedStoreDatabaseNow(
          store,
          highT3bMs,
          () => store.materializeTenantContentInventoryJobs({ limit: 1 }),
        )).toBe(1);
        expect((await store.getTenantContentInventoryJob(
          highT3bTenant,
          highT3b.requestId,
        ))?.retentionAnchorDbMs).toBe(highT3bMs);

        const highT3aMs = highT3bMs + 10_000;
        const highT3aTenant = `tenant-content-high-t3a-${randomUUID()}`;
        await store.setTenantAuth(highT3aTenant, DEFAULT_AUTH_POLICY);
        await installPolicy(store, highT3aTenant, 0);
        const highT3a = await advanceThroughExistingPolicyT3b(
          store,
          highT3aTenant,
          "erase_88888888-8888-4888-8888-888888888888",
          { credentialCompletionMs: highT3aMs },
        );
        expect(highT3a.credentialReceipt.storeDbTimestampMs).toBe(highT3aMs);
        expect(highT3a.runtimeReceipt.storeDbTimestampMs).toBeLessThan(highT3aMs);
        await expect(store.materializeTenantContentInventoryJobs({ limit: 1 }))
          .rejects.toMatchObject({ reason: "trusted_clock_before_source" });
        expect(await store.getTenantContentInventoryJob(highT3aTenant, highT3a.requestId))
          .toBeNull();
        expect(await withForcedStoreDatabaseNow(
          store,
          highT3aMs,
          () => store.materializeTenantContentInventoryJobs({ limit: 1 }),
        )).toBe(1);
        expect((await store.getTenantContentInventoryJob(
          highT3aTenant,
          highT3a.requestId,
        ))?.retentionAnchorDbMs).toBe(highT3aMs);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("seals a standalone context-compaction item without a turns row", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-content-compaction-${randomUUID()}`;
      try {
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(store, tenantId, 0);
        const compacted = await createStandaloneCompaction(store, tenantId, "compaction-user");
        const [turnRows] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS count FROM turns WHERE turn_id=?",
          [compacted.item.turnId],
        );
        expect(Number(turnRows[0]?.count)).toBe(0);
        const source = await advanceThroughExistingPolicyT3b(store, tenantId);
        expect(await store.materializeTenantContentInventoryJobs({ limit: 1 })).toBe(1);
        const claim = (await store.claimTenantContentInventories({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `compaction-${randomUUID()}`,
        })).find((candidate) => candidate.requestId === source.requestId)!;
        const authorization = inventoryAuthorization(claim);
        expect(await store.buildTenantContentInventoryPage(authorization, { limit: 10 }))
          .toMatchObject({ built: 1, done: true });
        expect(await store.sealTenantContentInventory(authorization)).toMatchObject({
          requestId: source.requestId,
          contentInventoryComplete: true,
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rejects ordinary, orphaned, and duplicate approval-request associations", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-content-approval-association-${randomUUID()}`;
      try {
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(store, tenantId, 0);
        const rich = await createRichSession(store, tenantId, "approval-user");
        expect(rich.approval.itemId).not.toBe(rich.item.id);
        const source = await advanceThroughExistingPolicyT3b(store, tenantId);
        await store.materializeTenantContentInventoryJobs({ limit: 1 });
        const claim = (await store.claimTenantContentInventories({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `approval-association-${randomUUID()}`,
        })).find((candidate) => candidate.requestId === source.requestId)!;
        const authorization = inventoryAuthorization(claim);
        const [itemRows] = await conn.query<RowDataPacket[]>(
          `SELECT item_id, session_id, user_id, turn_id, seq, type, status, body,
                  created_at_ms, completed_at_ms
             FROM items WHERE item_id=?`,
          [rich.item.id],
        );
        const row = itemRows[0]!;
        const original = (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as
          Extract<Item, { type: "approvalRequest" }>;
        const assertRejectedWithoutReceipt = async () => {
          await expect(store.buildTenantContentInventoryPage(authorization, { limit: 10 }))
            .rejects.toBeInstanceOf(TenantContentInventoryEvidenceChangedError);
          const [rows] = await conn.query<RowDataPacket[]>(
            "SELECT COUNT(*) AS count FROM session_content_receipts WHERE request_id=?",
            [source.requestId],
          );
          expect(Number(rows[0]?.count)).toBe(0);
        };

        const wrongType: Item = {
          id: original.id,
          sessionId: original.sessionId,
          turnId: original.turnId,
          seq: original.seq,
          ...(original.step === undefined ? {} : { step: original.step }),
          status: original.status,
          createdAtMs: original.createdAtMs,
          ...(original.completedAtMs === undefined
            ? {}
            : { completedAtMs: original.completedAtMs }),
          type: "agentMessage",
          text: "schema-valid but not an approval request",
          phase: "finalAnswer",
        };
        await conn.query(
          "UPDATE items SET type='agentMessage', body=? WHERE item_id=?",
          [JSON.stringify(wrongType), original.id],
        );
        await assertRejectedWithoutReceipt();
        await conn.query(
          "UPDATE items SET type='approvalRequest', body=? WHERE item_id=?",
          [JSON.stringify(original), original.id],
        );

        await conn.query(
          "UPDATE items SET body=JSON_SET(body, '$.approvalId', ?) WHERE item_id=?",
          [newId("apr"), original.id],
        );
        await assertRejectedWithoutReceipt();
        await conn.query("UPDATE items SET body=? WHERE item_id=?", [JSON.stringify(original), original.id]);

        const duplicate = { ...original, id: newId("item"), seq: 2 };
        await conn.query(
          `INSERT INTO items
             (item_id, session_id, user_id, turn_id, seq, type, status, body,
              created_at_ms, completed_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            duplicate.id,
            duplicate.sessionId,
            row.user_id,
            duplicate.turnId,
            duplicate.seq,
            duplicate.type,
            duplicate.status,
            JSON.stringify(duplicate),
            duplicate.createdAtMs,
            duplicate.completedAtMs ?? null,
          ],
        );
        await assertRejectedWithoutReceipt();
        await conn.query("DELETE FROM items WHERE item_id=?", [duplicate.id]);

        expect(await store.buildTenantContentInventoryPage(authorization, { limit: 10 }))
          .toMatchObject({ built: 1, done: true });
        expect(await store.sealTenantContentInventory(authorization)).toMatchObject({
          requestId: source.requestId,
          contentInventoryComplete: true,
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("detects a valid-to-valid approvalId topology swap after page capture", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-content-approval-swap-${randomUUID()}`;
      try {
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(store, tenantId, 0);
        const first = await createRichSession(store, tenantId, "approval-swap-user");
        const secondApprovalId = newId("apr");
        const atMs = Date.now();
        const secondItem: Extract<Item, { type: "approvalRequest" }> = {
          id: newId("item"),
          sessionId: first.session.id,
          turnId: first.turn.id,
          seq: 0,
          step: 1,
          status: "completed",
          createdAtMs: atMs,
          completedAtMs: atMs,
          type: "approvalRequest",
          approvalId: secondApprovalId,
          toolCallId: first.approval.toolCallId,
          name: first.approval.toolName,
          args: {},
        };
        const secondApproval: Approval = {
          ...first.approval,
          id: secondApprovalId,
          itemId: newId("item"),
          createdAtMs: atMs,
          expiresAtMs: atMs + 60_000,
        };
        await store.commit({
          sessionId: first.session.id,
          fence: 1,
          items: [secondItem],
          approvals: [secondApproval],
          events: [
            {
              type: "item/completed",
              sessionId: first.session.id,
              emittedAtMs: atMs,
              item: secondItem,
            },
            {
              type: "approval/requested",
              sessionId: first.session.id,
              emittedAtMs: atMs,
              approval: secondApproval,
            },
          ],
        });
        const source = await advanceThroughExistingPolicyT3b(store, tenantId);
        await store.materializeTenantContentInventoryJobs({ limit: 1 });
        const claim = (await store.claimTenantContentInventories({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `approval-swap-${randomUUID()}`,
        })).find((candidate) => candidate.requestId === source.requestId)!;
        const authorization = inventoryAuthorization(claim);
        await store.buildTenantContentInventoryPage(authorization, { limit: 10 });

        await conn.query(
          "UPDATE items SET body=JSON_SET(body, '$.approvalId', ?) WHERE item_id=?",
          [secondApproval.id, first.item.id],
        );
        await conn.query(
          "UPDATE items SET body=JSON_SET(body, '$.approvalId', ?) WHERE item_id=?",
          [first.approval.id, secondItem.id],
        );
        const [eventRows] = await conn.query<RowDataPacket[]>(
          `SELECT seq, body FROM events
            WHERE session_id=? AND type='item/completed' ORDER BY seq`,
          [first.session.id],
        );
        for (const row of eventRows) {
          const event = (typeof row.body === "string" ? JSON.parse(row.body) : row.body) as {
            item?: { id?: string; type?: string };
          };
          const approvalId = event.item?.id === first.item.id
            ? secondApproval.id
            : event.item?.id === secondItem.id ? first.approval.id : undefined;
          if (approvalId === undefined) continue;
          await conn.query(
            "UPDATE events SET body=JSON_SET(body, '$.item.approvalId', ?) WHERE session_id=? AND seq=?",
            [approvalId, first.session.id, row.seq],
          );
        }

        await expect(store.sealTenantContentInventory(authorization))
          .rejects.toBeInstanceOf(TenantContentInventoryEvidenceChangedError);
        expect(await store.getTenantContentInventoryReceipt(tenantId, source.requestId))
          .toBeNull();
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("has one concurrent claimant and rolls page/aggregate writes back after lease loss or SQL failure", async () => {
      const first = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const second = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-content-race-${randomUUID()}`;
      try {
        await first.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(first, tenantId, 0);
        await first.createSession(mkSession(tenantId, "rollback-user"));
        await first.createSession(mkSession(tenantId, "rollback-user"));
        const source = await advanceThroughExistingPolicyT3b(first, tenantId);
        expect(await first.materializeTenantContentInventoryJobs({ limit: 10 })).toBe(1);
        const [left, right] = await Promise.all([
          first.claimTenantContentInventories({
            limit: 1,
            leaseMs: 60_000,
            claimToken: `left-${randomUUID()}`,
          }),
          second.claimTenantContentInventories({
            limit: 1,
            leaseMs: 60_000,
            claimToken: `right-${randomUUID()}`,
          }),
        ]);
        expect(left.length + right.length).toBe(1);
        const initial = (left[0] ?? right[0])!;
        const initialAuthorization = inventoryAuthorization(initial);
        expect(await first.retryTenantContentInventory(initialAuthorization, {
          delayMs: 0,
          errorCode: "temporary_failure",
        })).toBe(true);
        const [expiring] = await first.claimTenantContentInventories({
          limit: 1,
          leaseMs: 1,
          claimToken: `expiring-${randomUUID()}`,
        });
        await waitUntilDatabaseTimePasses(conn, expiring!.leaseUntilMs);
        await expect(first.buildTenantContentInventoryPage(
          inventoryAuthorization(expiring!),
          { limit: 2 },
        )).rejects.toThrow("stale tenant content inventory authority");
        const [afterExpiry] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS receipts FROM session_content_receipts WHERE request_id=?",
          [source.requestId],
        );
        expect(Number(afterExpiry[0]?.receipts)).toBe(0);

        const [claim] = await first.claimTenantContentInventories({
          limit: 1,
          leaseMs: 60_000,
          claimToken: `rollback-${randomUUID()}`,
        });
        const authorization = inventoryAuthorization(claim!);
        expect(await first.renewTenantContentInventory(initialAuthorization, {
          leaseMs: 60_000,
        })).toBe(false);
        await conn.query(
          `CREATE TRIGGER test_fail_t3c_page
             BEFORE UPDATE ON tenant_content_inventory_jobs FOR EACH ROW
             BEGIN
               IF NEW.session_receipt_count > OLD.session_receipt_count THEN
                 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected page failure';
               END IF;
             END`,
        );
        await expect(first.buildTenantContentInventoryPage(authorization, { limit: 2 }))
          .rejects.toThrow("injected page failure");
        await conn.query("DROP TRIGGER test_fail_t3c_page");
        const [rolledBackPage] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM session_content_receipts WHERE request_id=?) AS receipts,
             (SELECT session_receipt_count FROM tenant_content_inventory_jobs
               WHERE request_id=?) AS job_receipts`,
          [source.requestId, source.requestId],
        );
        expect(rolledBackPage[0]).toMatchObject({ receipts: 0, job_receipts: 0 });

        expect(await first.buildTenantContentInventoryPage(authorization, { limit: 2 }))
          .toMatchObject({ built: 2, done: true, sessionReceiptCount: 2 });
        await conn.query(
          `CREATE TRIGGER test_fail_t3c_seal
             BEFORE UPDATE ON tenant_content_inventory_jobs FOR EACH ROW
             BEGIN
               IF NEW.phase = 'inventory_sealed' THEN
                 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected seal failure';
               END IF;
             END`,
        );
        await expect(first.sealTenantContentInventory(authorization))
          .rejects.toThrow("injected seal failure");
        await conn.query("DROP TRIGGER test_fail_t3c_seal");
        const [rolledBackSeal] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_content_inventory_receipts
               WHERE request_id=?) AS receipts,
             (SELECT COUNT(*) FROM tenant_content_inventory_jobs
               WHERE request_id=? AND phase='queued') AS queued_jobs`,
          [source.requestId, source.requestId],
        );
        expect(rolledBackSeal[0]).toMatchObject({ receipts: 0, queued_jobs: 1 });
        expect(await first.sealTenantContentInventory(authorization)).not.toBeNull();
      } finally {
        await conn.query("DROP TRIGGER IF EXISTS test_fail_t3c_page").catch(() => {});
        await conn.query("DROP TRIGGER IF EXISTS test_fail_t3c_seal").catch(() => {});
        await conn.end();
        await second.close();
        await first.close();
      }
    });

    it("rolls back page publication when the trusted DB clock is injected before its anchor", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-content-clock-rollback-${randomUUID()}`;
      try {
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(store, tenantId, 0);
        await store.createSession(mkSession(tenantId, "clock-rollback-user"));
        const source = await advanceThroughExistingPolicyT3b(store, tenantId);
        await store.materializeTenantContentInventoryJobs({ limit: 10 });
        const claim = (await store.claimTenantContentInventories({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `clock-rollback-${randomUUID()}`,
        })).find((candidate) => candidate.requestId === source.requestId)!;
        const authorization = inventoryAuthorization(claim);
        const job = await store.getTenantContentInventoryJob(tenantId, source.requestId);
        const mutableClock = store as unknown as {
          databaseNow(connection: unknown): Promise<number>;
        };
        const originalDatabaseNow = mutableClock.databaseNow;
        mutableClock.databaseNow = async () => job!.retentionAnchorDbMs - 1;
        try {
          await expect(store.buildTenantContentInventoryPage(authorization, { limit: 10 }))
            .rejects.toMatchObject({ reason: "trusted_clock_before_anchor" });
        } finally {
          mutableClock.databaseNow = originalDatabaseNow;
        }
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM session_content_receipts WHERE request_id=?) AS receipts,
             (SELECT session_receipt_count FROM tenant_content_inventory_jobs
               WHERE request_id=?) AS job_receipts,
             (SELECT cursor_session_id FROM tenant_content_inventory_jobs
               WHERE request_id=?) AS cursor_session_id`,
          [source.requestId, source.requestId, source.requestId],
        );
        expect(rows[0]).toMatchObject({ receipts: 0, job_receipts: 0, cursor_session_id: null });
        expect(await store.buildTenantContentInventoryPage(authorization, { limit: 10 }))
          .toMatchObject({ built: 1, done: true });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("keeps seal retryable when DB time rolls behind captured page evidence", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-content-evidence-clock-${randomUUID()}`;
      try {
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(store, tenantId, 0);
        await store.createSession(mkSession(tenantId, "evidence-clock-user"));
        const source = await advanceThroughExistingPolicyT3b(store, tenantId);
        await store.materializeTenantContentInventoryJobs({ limit: 1 });
        const claim = (await store.claimTenantContentInventories({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `evidence-clock-${randomUUID()}`,
        })).find((candidate) => candidate.requestId === source.requestId)!;
        const authorization = inventoryAuthorization(claim);
        const highClock = (await databaseNow(conn)) + 5_000;
        await withForcedStoreDatabaseNow(
          store,
          highClock,
          () => store.buildTenantContentInventoryPage(authorization, { limit: 10 }),
        );
        await expect(withForcedStoreDatabaseNow(
          store,
          highClock - 1_000,
          () => store.sealTenantContentInventory(authorization),
        )).rejects.toMatchObject({ reason: "trusted_clock_before_evidence" });
        const [rolledBack] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_content_inventory_receipts WHERE request_id=?) AS receipts,
             (SELECT phase FROM tenant_content_inventory_jobs WHERE request_id=?) AS phase`,
          [source.requestId, source.requestId],
        );
        expect(rolledBack[0]).toMatchObject({ receipts: 0, phase: "queued" });
        const aggregate = await withForcedStoreDatabaseNow(
          store,
          highClock,
          () => store.sealTenantContentInventory(authorization),
        );
        expect(aggregate).toMatchObject({
          requestId: source.requestId,
          storeDbTimestampMs: highClock,
        });
        expect(await store.getTenantContentInventoryReceipt(tenantId, source.requestId))
          .toEqual(aggregate);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("floors retry availability across renewal and a DB clock rollback", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const tenantId = `tenant-content-retry-clock-${randomUUID()}`;
      try {
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(store, tenantId, 0);
        const source = await advanceThroughExistingPolicyT3b(store, tenantId);
        await store.materializeTenantContentInventoryJobs({ limit: 1 });
        const initial = await store.getTenantContentInventoryJob(tenantId, source.requestId);
        let fakeNow = Math.max(initial!.availableAtMs!, initial!.updatedAtMs) + 10;
        const mutableClock = store as unknown as {
          databaseNow(connection: unknown): Promise<number>;
        };
        const originalDatabaseNow = mutableClock.databaseNow;
        mutableClock.databaseNow = async () => fakeNow;
        try {
          const first = (await store.claimTenantContentInventories({
            limit: 1,
            leaseMs: 1_000,
            claimToken: `retry-first-${randomUUID()}`,
          }))[0]!;
          expect(await store.retryTenantContentInventory(inventoryAuthorization(first), {
            delayMs: 100,
            errorCode: "temporary_failure",
          })).toBe(true);
          const firstRetry = await store.getTenantContentInventoryJob(tenantId, source.requestId);
          fakeNow = firstRetry!.availableAtMs!;
          const second = (await store.claimTenantContentInventories({
            limit: 1,
            leaseMs: 1_000,
            claimToken: `retry-second-${randomUUID()}`,
          }))[0]!;
          fakeNow += 50;
          expect(await store.renewTenantContentInventory(
            inventoryAuthorization(second),
            { leaseMs: 1_000 },
          )).toBe(true);
          const renewed = await store.getTenantContentInventoryJob(tenantId, source.requestId);
          fakeNow -= 75;
          expect(await store.retryTenantContentInventory(inventoryAuthorization(second), {
            delayMs: 0,
            errorCode: "temporary_failure",
          })).toBe(true);
          const secondRetry = await store.getTenantContentInventoryJob(tenantId, source.requestId);
          expect(secondRetry).toMatchObject({
            phase: "queued",
            availableAtMs: renewed!.updatedAtMs,
            updatedAtMs: renewed!.updatedAtMs,
          });
          expect(secondRetry!.availableAtMs).toBeGreaterThanOrEqual(firstRetry!.availableAtMs!);
          fakeNow = secondRetry!.availableAtMs!;
          expect(await store.claimTenantContentInventories({
            limit: 1,
            leaseMs: 1_000,
            claimToken: `retry-third-${randomUUID()}`,
          })).toEqual([
            expect.objectContaining({ requestId: source.requestId, claimAttempt: 3 }),
          ]);
        } finally {
          mutableClock.databaseNow = originalDatabaseNow;
        }
      } finally {
        await store.close();
      }
    });

    it("fails closed on deadline overflow and saturates leases at the safe-integer boundary", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const leaseTenant = `tenant-content-max-safe-lease-${randomUUID()}`;
      const overflowTenant = `tenant-content-deadline-overflow-${randomUUID()}`;
      try {
        await store.setTenantAuth(leaseTenant, DEFAULT_AUTH_POLICY);
        await installPolicy(store, leaseTenant, 0);
        const leaseSource = await advanceThroughExistingPolicyT3b(store, leaseTenant);
        expect(await store.materializeTenantContentInventoryJobs({ limit: 1 })).toBe(1);

        const [claim] = await withForcedStoreDatabaseNow(
          store,
          Number.MAX_SAFE_INTEGER - 1,
          () => store.claimTenantContentInventories({
            limit: 1,
            leaseMs: 100,
            claimToken: `max-safe-${randomUUID()}`,
          }),
        );
        expect(claim).toMatchObject({
          requestId: leaseSource.requestId,
          claimAttempt: 1,
          leaseUntilMs: Number.MAX_SAFE_INTEGER,
        });
        const authorization = inventoryAuthorization(claim!);
        expect(await withForcedStoreDatabaseNow(
          store,
          Number.MAX_SAFE_INTEGER - 1,
          () => store.renewTenantContentInventory(authorization, { leaseMs: 100 }),
        )).toBe(true);
        const beforeExhaustion = await store.getTenantContentInventoryJob(
          leaseTenant,
          leaseSource.requestId,
        );
        expect(beforeExhaustion).toMatchObject({
          attempts: 1,
          leaseUntilMs: Number.MAX_SAFE_INTEGER,
          updatedAtMs: Number.MAX_SAFE_INTEGER - 1,
        });

        expect(await withForcedStoreDatabaseNow(
          store,
          Number.MAX_SAFE_INTEGER,
          () => store.claimTenantContentInventories({
            limit: 1,
            leaseMs: 100,
            claimToken: `max-safe-exhausted-${randomUUID()}`,
          }),
        )).toEqual([]);
        expect(await withForcedStoreDatabaseNow(
          store,
          Number.MAX_SAFE_INTEGER,
          () => store.renewTenantContentInventory(authorization, { leaseMs: 100 }),
        )).toBe(false);
        expect(await store.getTenantContentInventoryJob(leaseTenant, leaseSource.requestId))
          .toEqual(beforeExhaustion);

        await store.setTenantAuth(overflowTenant, DEFAULT_AUTH_POLICY);
        await installPolicy(store, overflowTenant, 10);
        const overflowSource = await advanceThroughExistingPolicyT3b(store, overflowTenant);
        await expect(withForcedStoreDatabaseNow(
          store,
          Number.MAX_SAFE_INTEGER - 5,
          () => store.materializeTenantContentInventoryJobs({ limit: 1 }),
        )).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await store.getTenantContentInventoryJob(overflowTenant, overflowSource.requestId))
          .toBeNull();
      } finally {
        await store.close();
      }
    });

    it("keeps a valid inventory queued before the DB deadline and while any tenant user is held", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const deadlineTenant = `tenant-content-deadline-${randomUUID()}`;
      const holdTenant = `tenant-content-hold-${randomUUID()}`;
      try {
        await store.setTenantAuth(deadlineTenant, DEFAULT_AUTH_POLICY);
        await installPolicy(store, deadlineTenant, 60_000);
        await store.createSession(mkSession(deadlineTenant, "deadline-user"));
        const deadlineSource = await advanceThroughExistingPolicyT3b(store, deadlineTenant);
        await store.materializeTenantContentInventoryJobs({ limit: 10 });
        const deadlineClaim = (await store.claimTenantContentInventories({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `deadline-${randomUUID()}`,
        })).find((claim) => claim.requestId === deadlineSource.requestId)!;
        const deadlineAuthorization = inventoryAuthorization(deadlineClaim);
        await store.buildTenantContentInventoryPage(deadlineAuthorization, { limit: 10 });
        await expect(store.sealTenantContentInventory(deadlineAuthorization))
          .rejects.toMatchObject({ reason: "deadline_not_reached" });
        expect(await store.getTenantContentInventoryReceipt(
          deadlineTenant,
          deadlineSource.requestId,
        )).toBeNull();

        await store.setTenantAuth(holdTenant, DEFAULT_AUTH_POLICY);
        await installPolicy(store, holdTenant, 0);
        const held = await createRichSession(store, holdTenant, "held-user");
        await store.setLegalHold({
          tenantId: holdTenant,
          holdId: "hold_content_inventory",
          subjectKind: "user",
          subjectId: held.session.userId,
          reasonCode: "litigation",
          expectedControlGeneration: 0,
          actorKeyId: "legal-admin",
          atMs: Date.now(),
        });
        const holdSource = await advanceThroughExistingPolicyT3b(store, holdTenant);
        await store.materializeTenantContentInventoryJobs({ limit: 10 });
        const holdClaim = (await store.claimTenantContentInventories({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `hold-${randomUUID()}`,
        })).find((claim) => claim.requestId === holdSource.requestId)!;
        const holdAuthorization = inventoryAuthorization(holdClaim);
        await store.buildTenantContentInventoryPage(holdAuthorization, { limit: 10 });
        await expect(store.sealTenantContentInventory(holdAuthorization))
          .rejects.toBeInstanceOf(TenantContentInventoryNotReadyError);
        await expect(store.sealTenantContentInventory(holdAuthorization))
          .rejects.toMatchObject({ reason: "active_legal_hold" });
      } finally {
        await store.close();
      }
    });

    it("blocks a source-corrupt candidate without starving a healthy job in the same claim page", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      try {
        const fixtures: Array<{ tenantId: string; requestId: string }> = [];
        for (const tenantId of [
          `tenant-content-source-a-${randomUUID()}`,
          `tenant-content-source-b-${randomUUID()}`,
        ]) {
          await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
          await installPolicy(store, tenantId, 0);
          await store.createSession(mkSession(tenantId, `${tenantId}-user`));
          fixtures.push({ tenantId, ...await advanceThroughExistingPolicyT3b(store, tenantId) });
        }
        fixtures.sort((left, right) => left.requestId.localeCompare(right.requestId, "en"));
        const broken = fixtures[0]!;
        const healthy = fixtures[1]!;
        for (const trigger of [
          "trg_tenant_runtime_receipts_bu",
          "trg_tenant_runtime_receipts_bu_guard_a",
          "trg_tenant_runtime_receipts_bu_guard_b",
        ]) await conn.query(`DROP TRIGGER \`${trigger}\``);
        const [originalRows] = await conn.query<RowDataPacket[]>(
          "SELECT receipt_sha256 FROM tenant_runtime_revocation_receipts WHERE request_id=?",
          [broken.requestId],
        );
        const originalReceiptSha256 = String(originalRows[0]?.receipt_sha256);
        await conn.query(
          "UPDATE tenant_runtime_revocation_receipts SET receipt_sha256=? WHERE request_id=?",
          ["0".repeat(64), broken.requestId],
        );

        // The corrupt lexicographically-first source is reported, but bounded overscan commits
        // the healthy neighbor even with a caller materialization limit of one.
        await expect(store.materializeTenantContentInventoryJobs({ limit: 1 }))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        const [afterMaterialize] = await conn.query<RowDataPacket[]>(
          "SELECT tenant_id FROM tenant_content_inventory_jobs",
        );
        expect(afterMaterialize.map((row) => row.tenant_id)).toEqual([healthy.tenantId]);

        await conn.query(
          "UPDATE tenant_runtime_revocation_receipts SET receipt_sha256=? WHERE request_id=?",
          [originalReceiptSha256, broken.requestId],
        );
        expect(await store.materializeTenantContentInventoryJobs({ limit: 1 })).toBe(1);
        await conn.query(
          "UPDATE tenant_runtime_revocation_receipts SET receipt_sha256=? WHERE request_id=?",
          ["0".repeat(64), broken.requestId],
        );

        const claims = await store.claimTenantContentInventories({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `healthy-page-${randomUUID()}`,
        });
        expect(claims).toHaveLength(1);
        expect(claims[0]!.tenantId).toBe(healthy.tenantId);
        const [phases] = await conn.query<RowDataPacket[]>(
          "SELECT tenant_id, phase FROM tenant_content_inventory_jobs ORDER BY tenant_id",
        );
        expect(phases.find((row) => row.tenant_id === broken.tenantId)?.phase).toBe("blocked");
        expect(phases.find((row) => row.tenant_id === healthy.tenantId)?.phase).toBe("queued");
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("surfaces missing T1/T3b proof rows while materializing a healthy neighbor", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 10 });
      const conn = await mysql.createConnection(mysqlUrl);
      try {
        const fixtures: Array<{ tenantId: string; requestId: string }> = [];
        // Create the healthy/high-id request first so the global T3a cutover proof remains intact
        // when the two lexicographically earlier candidates are deliberately damaged.
        for (const [index, requestId] of [
          [2, "erase_ffffffff-ffff-4fff-bfff-fffffffffff4"],
          [0, "erase_00000000-0000-4000-8000-000000000041"],
          [1, "erase_11111111-1111-4111-8111-111111111111"],
        ] as const) {
          const tenantId = `tenant-content-missing-${index}-${randomUUID()}`;
          await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
          await installPolicy(store, tenantId, 0);
          await store.createSession(mkSession(tenantId, `missing-user-${index}`));
          fixtures.push({
            tenantId,
            ...await advanceThroughExistingPolicyT3b(store, tenantId, requestId),
          });
        }
        fixtures.sort((left, right) => (
          left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0
        ));
        const missingReceipt = fixtures[0]!;
        const missingAdmission = fixtures[1]!;
        const healthy = fixtures[2]!;
        for (const trigger of [
          "trg_tenant_runtime_receipts_bd",
          "trg_tenant_runtime_receipts_bd_guard_a",
          "trg_tenant_runtime_receipts_bd_guard_b",
          "trg_tenant_runtime_receipts_bd_bootstrap",
          "trg_tenant_erasure_admissions_bd",
          "trg_tenant_erasure_admissions_bd_guard_a",
          "trg_tenant_erasure_admissions_bd_guard_b",
          "trg_tenant_erasure_admissions_bd_bootstrap",
        ]) await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``);
        await conn.query(
          "DELETE FROM tenant_runtime_revocation_receipts WHERE request_id=?",
          [missingReceipt.requestId],
        );
        await conn.query(
          "DELETE FROM tenant_erasure_admissions WHERE request_id=?",
          [missingAdmission.requestId],
        );

        await expect(store.materializeTenantContentInventoryJobs({ limit: 1 }))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await store.getTenantContentInventoryJob(
          missingReceipt.tenantId,
          missingReceipt.requestId,
        )).toBeNull();
        expect(await store.getTenantContentInventoryJob(
          missingAdmission.tenantId,
          missingAdmission.requestId,
        )).toBeNull();
        expect(await store.getTenantContentInventoryJob(healthy.tenantId, healthy.requestId))
          .toMatchObject({ tenantId: healthy.tenantId, phase: "queued" });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("advances the bounded materializer keyset beyond a full corrupt scan window", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 12 });
      const conn = await mysql.createConnection(mysqlUrl);
      try {
        const fixtures: Array<{ tenantId: string; requestId: string }> = [];
        // limit=1 gives a bounded 32-source scan. Put a healthy source strictly beyond that window
        // and prove the next poll resumes from the prior keyset instead of rescanning the prefix.
        for (let index = 0; index < 34; index += 1) {
          const tenantId = `tenant-content-window-${index}-${randomUUID()}`;
          await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
          await installPolicy(store, tenantId, 0);
          await store.createSession(mkSession(tenantId, `window-user-${index}`));
          fixtures.push({ tenantId, ...await advanceThroughExistingPolicyT3b(store, tenantId) });
        }
        fixtures.sort((left, right) => (
          left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0
        ));
        const healthy = fixtures.at(-1)!;
        for (const trigger of [
          "trg_tenant_runtime_receipts_bu",
          "trg_tenant_runtime_receipts_bu_guard_a",
          "trg_tenant_runtime_receipts_bu_guard_b",
        ]) await conn.query(`DROP TRIGGER \`${trigger}\``);
        await conn.query(
          `UPDATE tenant_runtime_revocation_receipts
              SET receipt_sha256=SHA2(CONCAT('corrupt:', request_id), 256)
            WHERE request_id<>?`,
          [healthy.requestId],
        );

        await expect(store.materializeTenantContentInventoryJobs({ limit: 1 }))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await store.getTenantContentInventoryJob(healthy.tenantId, healthy.requestId))
          .toBeNull();

        await expect(store.materializeTenantContentInventoryJobs({ limit: 1 }))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await store.getTenantContentInventoryJob(healthy.tenantId, healthy.requestId))
          .toMatchObject({ tenantId: healthy.tenantId, phase: "queued" });
      } finally {
        await conn.end();
        await store.close();
      }
    }, 60_000);

    it("filters permanently unconfigured retention without starving an eligible materialization", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const ineligibleTenant = `tenant-content-unconfigured-${randomUUID()}`;
      const healthyTenant = `tenant-content-configured-${randomUUID()}`;
      try {
        await store.setTenantAuth(ineligibleTenant, DEFAULT_AUTH_POLICY);
        await installPolicy(store, ineligibleTenant, null);
        await store.createSession(mkSession(ineligibleTenant, "unconfigured-user"));
        const ineligible = await advanceThroughExistingPolicyT3b(store, ineligibleTenant);

        await store.setTenantAuth(healthyTenant, DEFAULT_AUTH_POLICY);
        await installPolicy(store, healthyTenant, 0);
        await store.createSession(mkSession(healthyTenant, "configured-user"));
        const healthy = await advanceThroughExistingPolicyT3b(store, healthyTenant);

        expect(await store.materializeTenantContentInventoryJobs({ limit: 1 })).toBe(1);
        expect(await store.getTenantContentInventoryJob(healthyTenant, healthy.requestId))
          .toMatchObject({ tenantId: healthyTenant, phase: "queued" });
        expect(await store.getTenantContentInventoryJob(ineligibleTenant, ineligible.requestId))
          .toBeNull();
      } finally {
        await store.close();
      }
    });

    it("skips a proof-valid unbound admission without requiring an active policy", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const tenantId = `tenant-content-unbound-${randomUUID()}`;
      try {
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await store.createSession(mkSession(tenantId, "unbound-user"));
        const source = await advanceThroughExistingPolicyT3b(store, tenantId);
        expect(await store.materializeTenantContentInventoryJobs({ limit: 10 })).toBe(0);
        expect(await store.getTenantContentInventoryJob(tenantId, source.requestId)).toBeNull();
      } finally {
        await store.close();
      }
    });

    it("rejects a structurally valid session receipt captured before the trusted DB anchor", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-content-anchor-${randomUUID()}`;
      try {
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(store, tenantId, 0);
        await store.createSession(mkSession(tenantId, "anchor-user"));
        const source = await advanceThroughExistingPolicyT3b(store, tenantId);
        await store.materializeTenantContentInventoryJobs({ limit: 10 });
        const [claim] = await store.claimTenantContentInventories({
          limit: 1,
          leaseMs: 60_000,
          claimToken: `anchor-${randomUUID()}`,
        });
        const authorization = inventoryAuthorization(claim!);
        await store.buildTenantContentInventoryPage(authorization, { limit: 10 });
        const job = await store.getTenantContentInventoryJob(tenantId, source.requestId);
        const [stored] = await store.getTenantSessionContentReceipts(
          tenantId,
          source.requestId,
          1,
        );
        const { receiptSha256: _oldHash, ...badBody } = {
          ...stored!,
          capturedAtDbMs: job!.retentionAnchorDbMs - 1,
        };
        const badHash = tenantSessionContentReceiptSha256(badBody);
        for (const trigger of [
          "trg_session_content_receipts_bu",
          "trg_session_content_receipts_bu_guard_a",
          "trg_session_content_receipts_bu_guard_b",
        ]) await conn.query(`DROP TRIGGER \`${trigger}\``);
        await conn.query(
          `UPDATE session_content_receipts
              SET captured_at_db_ms=?, receipt_sha256=?
            WHERE request_id=? AND build_generation=1 AND session_id=?`,
          [badBody.capturedAtDbMs, badHash, source.requestId, stored!.sessionId],
        );
        await expect(store.sealTenantContentInventory(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        const [aggregateRows] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS receipts FROM tenant_content_inventory_receipts WHERE request_id=?",
          [source.requestId],
        );
        expect(Number(aggregateRows[0]?.receipts)).toBe(0);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rejects schema-valid cross-owner, tombstone, and cross-turn event body corruption", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-content-events-${randomUUID()}`;
      try {
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(store, tenantId, 0);
        const first = await createRichSession(store, tenantId, "event-user");
        const other = await createRichSession(store, tenantId, "event-user");
        const siblingTurn: Turn = {
          id: newId("turn"),
          sessionId: first.session.id,
          status: "inProgress",
          seqStart: 4,
          steps: 1,
          toolCalls: 0,
          usage: emptyUsage(),
          startedAtMs: Date.now(),
        };
        const siblingItem: Item = {
          id: newId("item"),
          sessionId: first.session.id,
          turnId: siblingTurn.id,
          seq: 4,
          step: 1,
          status: "completed",
          createdAtMs: Date.now(),
          completedAtMs: Date.now(),
          type: "agentMessage",
          text: "same-session-cross-turn",
          phase: "finalAnswer",
        };
        await conn.query(
          `INSERT INTO turns
             (turn_id, session_id, user_id, status, stop_reason, seq_start, seq_end, body,
              idempotency_key, started_at_ms, completed_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            siblingTurn.id,
            siblingTurn.sessionId,
            first.session.userId,
            siblingTurn.status,
            null,
            siblingTurn.seqStart,
            null,
            JSON.stringify(siblingTurn),
            null,
            siblingTurn.startedAtMs,
            null,
          ],
        );
        await conn.query(
          `INSERT INTO items
             (item_id, session_id, user_id, turn_id, seq, type, status, body,
              created_at_ms, completed_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            siblingItem.id,
            siblingItem.sessionId,
            first.session.userId,
            siblingItem.turnId,
            siblingItem.seq,
            siblingItem.type,
            siblingItem.status,
            JSON.stringify(siblingItem),
            siblingItem.createdAtMs,
            siblingItem.completedAtMs,
          ],
        );

        const source = await advanceThroughExistingPolicyT3b(store, tenantId);
        await store.materializeTenantContentInventoryJobs({ limit: 10 });
        const claim = (await store.claimTenantContentInventories({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `events-${randomUUID()}`,
        })).find((candidate) => candidate.requestId === source.requestId)!;
        const authorization = inventoryAuthorization(claim);
        await store.buildTenantContentInventoryPage(authorization, { limit: 10 });

        const [eventRows] = await conn.query<RowDataPacket[]>(
          `SELECT seq, type, body, emitted_at_ms
             FROM events
            WHERE session_id=? AND type='item/completed'`,
          [first.session.id],
        );
        const eventRow = eventRows[0]!;
        const seq = Number(eventRow.seq);
        const emittedAtMs = Number(eventRow.emitted_at_ms);
        const originalType = String(eventRow.type);
        const originalBody = typeof eventRow.body === "string"
          ? eventRow.body
          : JSON.stringify(eventRow.body);
        const assertRejectedWithoutAggregate = async () => {
          await expect(store.sealTenantContentInventory(authorization))
            .rejects.toBeInstanceOf(TenantContentInventoryEvidenceChangedError);
          const [rows] = await conn.query<RowDataPacket[]>(
            `SELECT COUNT(*) AS receipts
               FROM tenant_content_inventory_receipts
              WHERE request_id=?`,
            [source.requestId],
          );
          expect(Number(rows[0]?.receipts)).toBe(0);
        };

        await conn.query(
          "UPDATE events SET body=? WHERE session_id=? AND seq=?",
          [JSON.stringify({
            type: "item/completed",
            sessionId: first.session.id,
            seq,
            emittedAtMs,
            item: other.item,
          }), first.session.id, seq],
        );
        await assertRejectedWithoutAggregate();

        await conn.query(
          "UPDATE events SET type='session/deleted', body=? WHERE session_id=? AND seq=?",
          [JSON.stringify({
            type: "session/deleted",
            sessionId: first.session.id,
            seq,
            emittedAtMs,
            deletionGeneration: 1,
          }), first.session.id, seq],
        );
        await assertRejectedWithoutAggregate();

        await conn.query(
          "UPDATE events SET type='turn/steered', body=? WHERE session_id=? AND seq=?",
          [JSON.stringify({
            type: "turn/steered",
            sessionId: first.session.id,
            seq,
            emittedAtMs,
            turnId: first.turn.id,
            itemId: siblingItem.id,
          }), first.session.id, seq],
        );
        await assertRejectedWithoutAggregate();

        await conn.query(
          "UPDATE events SET type=?, body=? WHERE session_id=? AND seq=?",
          [originalType, originalBody, first.session.id, seq],
        );

        // This alternate snapshot is internally valid and resolves to a real item/turn in the
        // same session. Only the v2 event topology root can distinguish it from the captured row.
        await conn.query(
          "UPDATE events SET body=? WHERE session_id=? AND seq=?",
          [JSON.stringify({
            type: "item/completed",
            sessionId: first.session.id,
            seq,
            emittedAtMs,
            item: siblingItem,
          }), first.session.id, seq],
        );
        await assertRejectedWithoutAggregate();
        await conn.query(
          "UPDATE events SET body=? WHERE session_id=? AND seq=?",
          [originalBody, first.session.id, seq],
        );

        await conn.query(
          "UPDATE turns SET body=JSON_SET(body, '$.seqStart', 1) WHERE turn_id=?",
          [first.turn.id],
        );
        await assertRejectedWithoutAggregate();
        await conn.query(
          "UPDATE turns SET body=JSON_SET(body, '$.seqStart', 2) WHERE turn_id=?",
          [first.turn.id],
        );

        await conn.query(
          "UPDATE items SET body=JSON_SET(body, '$.turnId', ?) WHERE item_id=?",
          [siblingTurn.id, first.item.id],
        );
        await assertRejectedWithoutAggregate();
        await conn.query(
          "UPDATE items SET body=JSON_SET(body, '$.turnId', ?) WHERE item_id=?",
          [first.turn.id, first.item.id],
        );

        await conn.query(
          "UPDATE approvals SET body=JSON_SET(body, '$.turnId', ?) WHERE approval_id=?",
          [siblingTurn.id, first.approval.id],
        );
        await assertRejectedWithoutAggregate();
        await conn.query(
          "UPDATE approvals SET body=JSON_SET(body, '$.turnId', ?) WHERE approval_id=?",
          [first.turn.id, first.approval.id],
        );

        await conn.query(
          `UPDATE turns
              SET seq_start=1, body=JSON_SET(body, '$.seqStart', 1)
            WHERE turn_id=?`,
          [first.turn.id],
        );
        await assertRejectedWithoutAggregate();
        await conn.query(
          `UPDATE turns
              SET seq_start=2, body=JSON_SET(body, '$.seqStart', 2)
            WHERE turn_id=?`,
          [first.turn.id],
        );
        expect(await store.sealTenantContentInventory(authorization)).not.toBeNull();
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls page and aggregate publication back when an INSERT wait crosses the lease", async () => {
      let store: MysqlSessionStore | undefined;
      let blocker: Connection | undefined;
      let observer: Connection | undefined;
      let clock: Connection | undefined;
      const tenantId = `tenant-content-insert-lease-${randomUUID()}`;
      const pageLockName = `t3c-page-${randomUUID()}`;
      const aggregateLockName = `t3c-aggregate-${randomUUID()}`;
      const pageTrigger = "test_hold_t3c_page_insert";
      const aggregateTrigger = "test_hold_t3c_aggregate_insert";
      let pageLockHeld = false;
      let aggregateLockHeld = false;
      let pagePending: Promise<unknown> | undefined;
      let sealPending: Promise<unknown> | undefined;
      try {
        store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
        blocker = await mysql.createConnection(mysqlUrl);
        observer = await mysql.createConnection(mysqlUrl);
        clock = await mysql.createConnection(mysqlUrl);
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(store, tenantId, 0);
        await store.createSession(mkSession(tenantId, "insert-lease-user"));
        const source = await advanceThroughExistingPolicyT3b(store, tenantId);
        await store.materializeTenantContentInventoryJobs({ limit: 1 });

        const [pageClaim] = await store.claimTenantContentInventories({
          limit: 1,
          leaseMs: 2_000,
          claimToken: `page-insert-lease-${randomUUID()}`,
        });
        const [pageLockRows] = await blocker.query<RowDataPacket[]>(
          "SELECT GET_LOCK(?, 5) AS acquired",
          [pageLockName],
        );
        expect(Number(pageLockRows[0]?.acquired)).toBe(1);
        pageLockHeld = true;
        await blocker.query(
          `CREATE TRIGGER ${pageTrigger}
             BEFORE INSERT ON session_content_receipts FOR EACH ROW
           BEGIN
             SET @t3c_page_gate = GET_LOCK('${pageLockName}', 30);
             IF @t3c_page_gate <> 1 THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='page insert gate timed out';
             END IF;
             SET @t3c_page_release = RELEASE_LOCK('${pageLockName}');
           END`,
        );
        pagePending = store.buildTenantContentInventoryPage(
          inventoryAuthorization(pageClaim!),
          { limit: 10 },
        );
        await waitForBlockedQuery(observer, ["User lock"]);
        await waitUntilDatabaseTimePasses(clock, pageClaim!.leaseUntilMs);
        await blocker.query("SELECT RELEASE_LOCK(?)", [pageLockName]);
        pageLockHeld = false;
        await expect(pagePending).rejects.toThrow("stale tenant content inventory authority");
        const [pageRollback] = await clock.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM session_content_receipts WHERE request_id=?) AS receipts,
             cursor_session_id, scan_complete, session_receipt_count, phase
             FROM tenant_content_inventory_jobs WHERE request_id=?`,
          [source.requestId, source.requestId],
        );
        expect(pageRollback[0]).toMatchObject({
          receipts: 0,
          cursor_session_id: null,
          scan_complete: 0,
          session_receipt_count: 0,
          phase: "queued",
        });
        await blocker.query(`DROP TRIGGER ${pageTrigger}`);

        const [buildClaim] = await store.claimTenantContentInventories({
          limit: 1,
          leaseMs: 60_000,
          claimToken: `aggregate-build-${randomUUID()}`,
        });
        const buildAuthorization = inventoryAuthorization(buildClaim!);
        await store.buildTenantContentInventoryPage(buildAuthorization, { limit: 10 });
        expect(await store.retryTenantContentInventory(buildAuthorization, {
          delayMs: 0,
          errorCode: "temporary_failure",
        })).toBe(true);
        const [sealClaim] = await store.claimTenantContentInventories({
          limit: 1,
          leaseMs: 2_000,
          claimToken: `aggregate-insert-lease-${randomUUID()}`,
        });
        const sealAuthorization = inventoryAuthorization(sealClaim!);
        const [aggregateLockRows] = await blocker.query<RowDataPacket[]>(
          "SELECT GET_LOCK(?, 5) AS acquired",
          [aggregateLockName],
        );
        expect(Number(aggregateLockRows[0]?.acquired)).toBe(1);
        aggregateLockHeld = true;
        await blocker.query(
          `CREATE TRIGGER ${aggregateTrigger}
             BEFORE INSERT ON tenant_content_inventory_receipts FOR EACH ROW
           BEGIN
             SET @t3c_aggregate_gate = GET_LOCK('${aggregateLockName}', 30);
             IF @t3c_aggregate_gate <> 1 THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='aggregate insert gate timed out';
             END IF;
             SET @t3c_aggregate_release = RELEASE_LOCK('${aggregateLockName}');
           END`,
        );
        sealPending = store.sealTenantContentInventory(sealAuthorization);
        await waitForBlockedQuery(observer, ["User lock"]);
        await waitUntilDatabaseTimePasses(clock, sealClaim!.leaseUntilMs);
        await blocker.query("SELECT RELEASE_LOCK(?)", [aggregateLockName]);
        aggregateLockHeld = false;
        await expect(sealPending).rejects.toThrow("stale tenant content inventory authority");
        const [aggregateRollback] = await clock.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_content_inventory_receipts WHERE request_id=?) AS receipts,
             phase, scan_complete, session_receipt_count
             FROM tenant_content_inventory_jobs WHERE request_id=?`,
          [source.requestId, source.requestId],
        );
        expect(aggregateRollback[0]).toMatchObject({
          receipts: 0,
          phase: "queued",
          scan_complete: 1,
          session_receipt_count: 1,
        });
        await blocker.query(`DROP TRIGGER ${aggregateTrigger}`);

        const [finalClaim] = await store.claimTenantContentInventories({
          limit: 1,
          leaseMs: 60_000,
          claimToken: `aggregate-retry-${randomUUID()}`,
        });
        expect(await store.sealTenantContentInventory(inventoryAuthorization(finalClaim!)))
          .toMatchObject({ requestId: source.requestId, contentInventoryComplete: true });
      } finally {
        if (pageLockHeld) {
          await blocker?.query("SELECT RELEASE_LOCK(?)", [pageLockName]).catch(() => {});
        }
        if (aggregateLockHeld) {
          await blocker?.query("SELECT RELEASE_LOCK(?)", [aggregateLockName]).catch(() => {});
        }
        await pagePending?.catch(() => {});
        await sealPending?.catch(() => {});
        await blocker?.query(`DROP TRIGGER IF EXISTS ${pageTrigger}`).catch(() => {});
        await blocker?.query(`DROP TRIGGER IF EXISTS ${aggregateTrigger}`).catch(() => {});
        await clock?.end().catch(() => {});
        await observer?.end().catch(() => {});
        await blocker?.end().catch(() => {});
        await store?.close().catch(() => {});
      }
    }, 30_000);

    it("pins seal to repeatable-read and range-locks inserts despite a read-committed session default", async () => {
      let store: MysqlSessionStore | undefined;
      let blocker: Connection | undefined;
      let writer: Connection | undefined;
      let observer: Connection | undefined;
      const tenantId = `tenant-content-rr-${randomUUID()}`;
      const lockName = `t3c-${randomUUID()}`;
      const triggerName = "test_hold_t3c_aggregate";
      let gateHeld = false;
      let sealPending: Promise<unknown> | undefined;
      let writerPending: Promise<void> | undefined;
      try {
        store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
        blocker = await mysql.createConnection(mysqlUrl);
        writer = await mysql.createConnection(mysqlUrl);
        observer = await mysql.createConnection(mysqlUrl);
        await writer.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
        const [writerIsolationRows] = await writer.query<RowDataPacket[]>(
          "SELECT @@SESSION.transaction_isolation AS isolation_level",
        );
        expect(String(writerIsolationRows[0]?.isolation_level)).toBe("READ-COMMITTED");
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(store, tenantId, 0);
        await store.createSession(mkSession(tenantId, "rr-user"));
        const source = await advanceThroughExistingPolicyT3b(store, tenantId);
        await store.materializeTenantContentInventoryJobs({ limit: 10 });
        const claim = (await store.claimTenantContentInventories({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `rr-${randomUUID()}`,
        })).find((candidate) => candidate.requestId === source.requestId)!;
        const authorization = inventoryAuthorization(claim);
        await store.buildTenantContentInventoryPage(authorization, { limit: 10 });
        await setStoreSessionsReadCommitted(store, 2);

        const [lockRows] = await blocker.query<RowDataPacket[]>(
          "SELECT GET_LOCK(?, 5) AS acquired",
          [lockName],
        );
        expect(Number(lockRows[0]?.acquired)).toBe(1);
        gateHeld = true;
        await blocker.query(
          `CREATE TRIGGER ${triggerName}
             BEFORE INSERT ON tenant_content_inventory_receipts FOR EACH ROW
           BEGIN
             SET @t3c_gate_acquired = GET_LOCK('${lockName}', 30);
             IF @t3c_gate_acquired <> 1 THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test aggregate gate timed out';
             END IF;
             SET @t3c_gate_released = RELEASE_LOCK('${lockName}');
           END`,
        );

        sealPending = store.sealTenantContentInventory(authorization);
        await waitForBlockedQuery(observer, ["User lock"]);

        const orphanTurnId = newId("turn");
        let writerSettled = false;
        writerPending = writer.query(
          `INSERT INTO turns
             (turn_id, session_id, user_id, status, stop_reason, seq_start, seq_end, body,
              idempotency_key, started_at_ms, completed_at_ms)
           VALUES (?,?,?,'inProgress',NULL,1,NULL,JSON_OBJECT(),NULL,?,NULL)`,
          [orphanTurnId, newId("sess"), "post-scan-orphan", Date.now()],
        ).then(() => {
          writerSettled = true;
        });
        await waitForBlockedQuery(observer, ["INSERT INTO turns"]);
        expect(writerSettled).toBe(false);

        await blocker.query("SELECT RELEASE_LOCK(?)", [lockName]);
        gateHeld = false;
        const aggregate = await sealPending;
        expect(aggregate).not.toBeNull();
        expect(await store.getTenantContentInventoryReceipt(tenantId, source.requestId))
          .toEqual(aggregate);
        expect(await store.sealTenantContentInventory(authorization)).toEqual(aggregate);
        await writerPending;
        expect(writerSettled).toBe(true);
      } finally {
        if (gateHeld) {
          await blocker?.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
        }
        await sealPending?.catch(() => {});
        await writerPending?.catch(() => {});
        await blocker?.query(`DROP TRIGGER IF EXISTS ${triggerName}`).catch(() => {});
        await observer?.end().catch(() => {});
        await writer?.end().catch(() => {});
        await blocker?.end().catch(() => {});
        await store?.close().catch(() => {});
      }
    }, 30_000);

    it("rejects a two-session parent cycle before publishing the global proof", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-content-cycle-${randomUUID()}`;
      try {
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await installPolicy(store, tenantId, 0);
        const parent = mkSession(tenantId, "cycle-user");
        const child = { ...mkSession(tenantId, "cycle-user"), parentSessionId: parent.id };
        await store.createSession(parent);
        await store.createSession(child);
        await conn.query(
          "UPDATE sessions SET parent_session_id=? WHERE session_id=?",
          [child.id, parent.id],
        );
        const source = await advanceThroughExistingPolicyT3b(store, tenantId);
        await store.materializeTenantContentInventoryJobs({ limit: 10 });
        const claim = (await store.claimTenantContentInventories({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `cycle-${randomUUID()}`,
        })).find((candidate) => candidate.requestId === source.requestId)!;
        const authorization = inventoryAuthorization(claim);
        await store.buildTenantContentInventoryPage(authorization, { limit: 10 });
        await expect(store.sealTenantContentInventory(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await store.getTenantContentInventoryReceipt(tenantId, source.requestId))
          .toBeNull();
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rejects post-page owner drift and a global orphan without publishing an aggregate", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const driftTenant = `tenant-content-drift-${randomUUID()}`;
      try {
        await store.setTenantAuth(driftTenant, DEFAULT_AUTH_POLICY);
        await installPolicy(store, driftTenant, 0);
        const rich = await createRichSession(store, driftTenant, "drift-user");
        const source = await advanceThroughExistingPolicyT3b(store, driftTenant);
        await store.materializeTenantContentInventoryJobs({ limit: 10 });
        const claim = (await store.claimTenantContentInventories({
          limit: 10,
          leaseMs: 60_000,
          claimToken: `drift-${randomUUID()}`,
        })).find((candidate) => candidate.requestId === source.requestId)!;
        const authorization = inventoryAuthorization(claim);
        await store.buildTenantContentInventoryPage(authorization, { limit: 10 });
        await conn.query("UPDATE items SET seq=2 WHERE item_id=?", [rich.item.id]);
        await expect(store.sealTenantContentInventory(authorization))
          .rejects.toBeInstanceOf(TenantContentInventoryEvidenceChangedError);
        const [afterDrift] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS receipts FROM tenant_content_inventory_receipts WHERE request_id=?",
          [source.requestId],
        );
        expect(Number(afterDrift[0]?.receipts)).toBe(0);

        await conn.query("UPDATE items SET seq=3 WHERE item_id=?", [rich.item.id]);
        const orphanTurnId = newId("turn");
        await conn.query(
          `INSERT INTO turns
             (turn_id, session_id, user_id, status, stop_reason, seq_start, seq_end, body,
              idempotency_key, started_at_ms, completed_at_ms)
           VALUES (?,?,?,'inProgress',NULL,1,NULL,JSON_OBJECT(),NULL,?,NULL)`,
          [orphanTurnId, newId("sess"), "orphan-user", Date.now()],
        );
        await expect(store.sealTenantContentInventory(authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await store.getTenantContentInventoryReceipt(driftTenant, source.requestId))
          .toBeNull();
      } finally {
        await conn.end();
        await store.close();
      }
    });
  });
}

async function advanceThroughExistingPolicyT3b(
  store: MysqlSessionStore,
  tenantId: string,
  requestId = newErasureRequestId(),
  forcedClocks: {
    credentialCompletionMs?: number;
    runtimeCompletionMs?: number;
  } = {},
) {
  const request = {
    requestId,
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey: `existing-policy-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: Date.now(),
  };
  await store.requestTenantErasure(request);
  const credential = (await store.claimTenantCredentialRevocations({
    limit: 10,
    leaseMs: 60_000,
    claimToken: `credential-${randomUUID()}`,
  })).find((claim) => claim.requestId === request.requestId)!;
  const credentialOperation = () => store.revokeTenantCredentialMaterial(
    credentialAuthorization(credential),
  );
  const credentialReceipt = forcedClocks.credentialCompletionMs === undefined
    ? await credentialOperation()
    : await withForcedStoreDatabaseNow(
        store,
        forcedClocks.credentialCompletionMs,
        credentialOperation,
      );
  if (!credentialReceipt) throw new Error("missing credential completion receipt");
  await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
  const runtime = (await store.claimTenantRuntimeRevocations({
    limit: 10,
    leaseMs: 60_000,
    claimToken: `runtime-${randomUUID()}`,
  })).find((claim) => claim.requestId === request.requestId)!;
  const runtimeOperation = () => store.completeTenantRuntimeRevocation(
    runtimeAuthorization(runtime),
    fleetProof(runtime),
  );
  const runtimeReceipt = forcedClocks.runtimeCompletionMs === undefined
    ? await runtimeOperation()
    : await withForcedStoreDatabaseNow(
        store,
        forcedClocks.runtimeCompletionMs,
        runtimeOperation,
      );
  if (!runtimeReceipt) throw new Error("missing runtime completion receipt");
  return { requestId: request.requestId, credentialReceipt, runtimeReceipt };
}
