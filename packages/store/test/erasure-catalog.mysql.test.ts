import { randomUUID } from "node:crypto";
import mysql, { type Connection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MysqlSessionStore,
  newErasureRequestId,
  userErasureRequestHash,
  type ErasureJobAuthorization,
  type ErasureJobClaim,
  type ErasureRequestStatus,
  type ErasureScanPhase,
  type ErasureSessionRef,
  type ErasureWriteAuthorization,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create erasure catalog fixture database from base database "${database}": `
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

function writeAuthorization(claim: ErasureJobClaim): ErasureWriteAuthorization {
  if (claim.subjectKind !== "user") throw new Error("catalog fixture requires a user erasure claim");
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    userId: claim.subjectId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

async function claimRequest(
  store: MysqlSessionStore,
  requestId: string,
  nowMs: number,
  token: string,
  leaseMs = 600_000,
): Promise<ErasureJobClaim> {
  const claim = (await store.claimErasureJobs({ nowMs, limit: 100, leaseMs, claimToken: token }))
    .find((candidate) => candidate.requestId === requestId);
  if (!claim) throw new Error(`failed to claim erasure request ${requestId}`);
  return claim;
}

async function gateAndClaim(
  store: MysqlSessionStore,
  tenantId: string,
  userId: string,
  targetStatus: ErasureScanPhase,
  tokenPrefix: string,
  atMs = Date.now(),
): Promise<{ requestId: string; claim: ErasureJobClaim; authority: ErasureWriteAuthorization; nowMs: number }> {
  const tokenFor = (status: ErasureRequestStatus) => `${tokenPrefix.slice(0, 32)}-${status}`;
  const requestId = newErasureRequestId();
  await store.requestUserErasure({
    requestId,
    tenantId,
    userId,
    requestedByKeyId: "admin-key",
    idempotencyKey: `erase-${randomUUID()}`,
    requestHash: userErasureRequestHash(tenantId, userId),
    atMs,
  });
  let nowMs = atMs;
  let claim = await claimRequest(store, requestId, nowMs, tokenFor("gated"));
  const path: readonly ErasureRequestStatus[] = targetStatus === "draining"
    ? ["draining"]
    : targetStatus === "tombstoning"
      ? ["draining", "tombstoning"]
      : ["draining", "tombstoning", "reconciling_usage"];
  for (const nextStatus of path) {
    nowMs += 1;
    expect(await store.transitionErasureJob(jobAuthorization(claim), {
      fromStatus: claim.status,
      toStatus: nextStatus,
      atMs: nowMs,
      availableAtMs: nowMs,
    })).toBe(true);
    claim = await claimRequest(store, requestId, nowMs, tokenFor(nextStatus));
  }
  return { requestId, claim, authority: writeAuthorization(claim), nowMs };
}

async function archiveSession(store: MysqlSessionStore, sessionId: string, tenantId: string, userId: string): Promise<void> {
  const atMs = Date.now();
  await store.commit({
    sessionId,
    fence: 1,
    lifecycle: { type: "archive", atMs, tenantId, userId },
    events: [{ type: "session/archived", sessionId, emittedAtMs: atMs }],
  });
}

async function commitTombstone(store: MysqlSessionStore, session: ReturnType<typeof mkSession>, atMs: number): Promise<void> {
  await store.commit({
    sessionId: session.id,
    fence: 1,
    lifecycle: {
      type: "tombstone",
      tenantId: session.tenantId,
      userId: session.userId,
      deletionGeneration: 1,
      atMs,
    },
    events: [{
      type: "session/deleted",
      sessionId: session.id,
      deletionGeneration: 1,
      emittedAtMs: atMs,
    }],
  });
}

async function collectCatalog(
  store: MysqlSessionStore,
  authority: ErasureWriteAuthorization,
  phase: ErasureScanPhase,
  nowMs: number,
  limit: number,
) {
  const data: ErasureSessionRef[] = [];
  const pageSizes: number[] = [];
  let afterSessionId: string | undefined;
  for (;;) {
    const page = await store.listErasureSessions(authority, {
      phase,
      nowMs,
      limit,
      ...(afterSessionId === undefined ? {} : { afterSessionId }),
    });
    data.push(...page.data);
    pageSizes.push(page.data.length);
    if (page.nextCursor === undefined) return { data, pageSizes };
    expect(page.nextCursor).not.toBe(afterSessionId);
    afterSessionId = page.nextCursor;
  }
}

async function insertReconciliation(
  conn: Connection,
  input: {
    tenantId: string;
    userId: string;
    sessionId: string;
    generation: number;
    status: "verified" | "anonymized";
  },
): Promise<void> {
  await conn.query(
    `INSERT INTO usage_reconciliations
       (tenant_id, user_id, session_id, deletion_generation, status, row_count, input_tokens,
        output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
        known_cost_rows, cost_cny, checksum, verified_at_ms, anonymized_at_ms, created_at_ms,
        updated_at_ms)
     VALUES (?,?,?,?,?,0,0,0,0,0,0,0,0,NULL,?,100,?,100,?)`,
    [
      input.tenantId,
      input.userId,
      input.sessionId,
      input.generation,
      input.status,
      "a".repeat(64),
      input.status === "anonymized" ? 101 : null,
      input.status === "anonymized" ? 101 : 100,
    ],
  );
}

async function insertUsage(
  conn: Connection,
  tenantId: string,
  userId: string,
  sessionId: string,
): Promise<void> {
  await conn.query(
    `INSERT INTO usage_ledger
       (usage_id, tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms)
     VALUES (NULL,?,?,?,?,1,'fixture','fixture-model',?,100)`,
    [
      tenantId,
      userId,
      sessionId,
      newId("turn"),
      JSON.stringify({
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
      }),
    ],
  );
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore erasure session catalog", () => {
    let admin: Connection | undefined;
    let mysqlUrl = "";
    let database = "";

    beforeAll(async () => {
      const base = assertDisposableTestTarget(BASE_MYSQL_URL);
      database = `agent_service_erasure_catalog_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_erasure_catalog_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe generated erasure catalog fixture database name");
      }
      admin = await mysql.createConnection(databaseUrl(base, "mysql"));
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      mysqlUrl = databaseUrl(base, database);
      const migrated = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1 });
      await migrated.close();
    });

    afterAll(async () => {
      if (admin && database) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin?.end();
    });

    it("pages every live draining session in ascending order, including archived sessions", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_catalog_drain_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      const sessions = [mkSession(tenantId, userId)];
      sessions.push({ ...mkSession(tenantId, userId), parentSessionId: sessions[0]!.id });
      sessions.push(mkSession(tenantId, userId), mkSession(tenantId, userId), mkSession(tenantId, userId));
      const foreign = mkSession(tenantId, `user_${randomUUID()}`);
      try {
        for (const session of [...sessions, foreign]) await store.createSession(session);
        await archiveSession(store, sessions[2]!.id, tenantId, userId);
        await conn.query(
          "UPDATE sessions SET deleted_at_ms=100, deletion_generation=1 WHERE session_id=?",
          [sessions[4]!.id],
        );
        const { authority, nowMs } = await gateAndClaim(
          store,
          tenantId,
          userId,
          "draining",
          `catalog-drain-${randomUUID()}`,
        );

        const result = await collectCatalog(store, authority, "draining", nowMs, 2);
        const expected = sessions.slice(0, 4).map((session) => session.id).sort();
        expect(result.data.map((session) => session.sessionId)).toEqual(expected);
        expect(result.pageSizes).toEqual([2, 2]);
        expect(result.data).toContainEqual({
          sessionId: sessions[1]!.id,
          parentSessionId: sessions[0]!.id,
          deleted: false,
          deletionGeneration: 0,
        });
        for (const ref of result.data) {
          expect(Object.keys(ref).sort()).toEqual(
            ref.parentSessionId === undefined
              ? ["deleted", "deletionGeneration", "sessionId"]
              : ["deleted", "deletionGeneration", "parentSessionId", "sessionId"],
          );
        }
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("returns only live leaves for tombstoning and lets a cross-owner live child block its parent", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_catalog_tree_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      const root = mkSession(tenantId, userId);
      const child = { ...mkSession(tenantId, userId), parentSessionId: root.id };
      const grandchild = { ...mkSession(tenantId, userId), parentSessionId: child.id };
      const archivedLeaf = mkSession(tenantId, userId);
      const crossOwnerBlocked = mkSession(tenantId, userId);
      const deletedChildParent = mkSession(tenantId, userId);
      const deletedChild = { ...mkSession(tenantId, userId), parentSessionId: deletedChildParent.id };
      const foreignChild = mkSession(tenantId, `user_${randomUUID()}`);
      try {
        for (const session of [
          root,
          child,
          grandchild,
          archivedLeaf,
          crossOwnerBlocked,
          deletedChildParent,
          deletedChild,
          foreignChild,
        ]) await store.createSession(session);
        await archiveSession(store, archivedLeaf.id, tenantId, userId);
        await conn.query(
          "UPDATE sessions SET parent_session_id=? WHERE session_id=?",
          [crossOwnerBlocked.id, foreignChild.id],
        );
        await conn.query(
          "UPDATE sessions SET deleted_at_ms=100, deletion_generation=1 WHERE session_id=?",
          [deletedChild.id],
        );
        const { authority, nowMs } = await gateAndClaim(
          store,
          tenantId,
          userId,
          "tombstoning",
          `catalog-tree-${randomUUID()}`,
        );

        const result = await collectCatalog(store, authority, "tombstoning", nowMs, 2);
        expect(result.data.map((session) => session.sessionId)).toEqual(
          [grandchild.id, archivedLeaf.id, deletedChildParent.id].sort(),
        );
        expect(result.pageSizes).toEqual([2, 1]);
        expect(result.data.every((session) => !session.deleted)).toBe(true);
        expect(result.data.map((session) => session.sessionId)).not.toContain(crossOwnerBlocked.id);
        expect(await store.inspectErasureSubjectProgress(authority, {
          phase: "tombstoning",
          nowMs,
        })).toMatchObject({
          totalSessions: 7,
          liveSessions: 6,
          liveLeafSessions: 3,
          tombstonedSessions: 1,
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("reports generation, reconciliation, orphan, and both directions of owner mismatch without content", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_catalog_progress_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      const liveParent = mkSession(tenantId, userId);
      const liveChild = { ...mkSession(tenantId, userId), parentSessionId: liveParent.id };
      const tombstones = Array.from({ length: 5 }, () => mkSession(tenantId, userId));
      const foreignUserId = `user_${randomUUID()}`;
      const foreign = mkSession(tenantId, foreignUserId);
      const absentTargetOwned = newId("sess");
      const absentForeignOwned = newId("sess");
      try {
        for (const session of [liveParent, liveChild, ...tombstones, foreign]) {
          await store.createSession(session);
        }
        for (const [index, session] of tombstones.entries()) {
          const generation = index === 0 ? 0 : index === 2 ? 2 : 1;
          await conn.query(
            "UPDATE sessions SET deleted_at_ms=?, deletion_generation=? WHERE session_id=?",
            [100 + index, generation, session.id],
          );
        }
        await insertReconciliation(conn, {
          tenantId,
          userId,
          sessionId: tombstones[1]!.id,
          generation: 1,
          status: "verified",
        });
        await insertReconciliation(conn, {
          tenantId,
          userId,
          sessionId: tombstones[2]!.id,
          generation: 2,
          status: "anonymized",
        });
        await insertReconciliation(conn, {
          tenantId,
          userId: foreignUserId,
          sessionId: tombstones[4]!.id,
          generation: 1,
          status: "verified",
        });

        await insertUsage(conn, tenantId, userId, tombstones[1]!.id); // valid target row
        await insertUsage(conn, tenantId, userId, absentTargetOwned); // target-owned orphan
        await insertUsage(conn, tenantId, userId, foreign.id); // target usage points at foreign owner
        await insertUsage(conn, tenantId, foreignUserId, tombstones[2]!.id); // foreign usage points at target
        await insertUsage(conn, tenantId, foreignUserId, absentForeignOwned); // unrelated orphan

        const { authority, nowMs } = await gateAndClaim(
          store,
          tenantId,
          userId,
          "reconciling_usage",
          `catalog-progress-${randomUUID()}`,
        );
        const listed = await collectCatalog(store, authority, "reconciling_usage", nowMs, 2);
        expect(listed.data.map((session) => session.sessionId)).toEqual(
          tombstones.map((session) => session.id).sort(),
        );
        expect(listed.pageSizes).toEqual([2, 2, 1]);
        expect(listed.data.every((session) => session.deleted)).toBe(true);
        expect(listed.data.every((session) => session.tombstoneProofValid === false)).toBe(true);

        const progress = await store.inspectErasureSubjectProgress(authority, {
          phase: "reconciling_usage",
          nowMs,
        });
        expect(progress).toEqual({
          totalSessions: 7,
          liveSessions: 2,
          liveLeafSessions: 1,
          tombstonedSessions: 5,
          legacyGenerationZeroSessions: 1,
          reconciledUsageSessions: 2,
          unreconciledUsageSessions: 2,
          orphanOrMismatchedUsageRows: 3,
        });
        expect(Object.values(progress).every((value) => Number.isSafeInteger(value) && value >= 0)).toBe(true);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("returns a claim-bound proof for a complete tombstone and no user content", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const session = mkSession(`tenant_catalog_proof_${randomUUID()}`, `user_${randomUUID()}`);
      const atMs = Date.now();
      try {
        await store.createSession(session);
        await commitTombstone(store, session, atMs);
        const { authority, nowMs } = await gateAndClaim(
          store,
          session.tenantId,
          session.userId,
          "reconciling_usage",
          `catalog-proof-${randomUUID()}`,
          atMs + 1,
        );

        const page = await store.listErasureSessions(authority, {
          phase: "reconciling_usage",
          nowMs,
          limit: 10,
        });
        expect(page).toEqual({
          data: [{
            sessionId: session.id,
            deleted: true,
            deletionGeneration: 1,
            tombstoneProofValid: true,
          }],
        });
        expect(Object.keys(page.data[0]!).sort()).toEqual([
          "deleted",
          "deletionGeneration",
          "sessionId",
          "tombstoneProofValid",
        ]);
      } finally {
        await store.close();
      }
    });

    it.each([
      ["marker purge schedule", async (conn: Connection, sessionId: string) => {
        await conn.query("UPDATE sessions SET purge_after_ms=1 WHERE session_id=?", [sessionId]);
      }],
      ["marker/event timestamp mismatch", async (conn: Connection, sessionId: string) => {
        await conn.query("UPDATE sessions SET deleted_at_ms=deleted_at_ms+1 WHERE session_id=?", [sessionId]);
      }],
      ["terminal event column owner", async (conn: Connection, sessionId: string) => {
        await conn.query("UPDATE events SET user_id='wrong-owner' WHERE session_id=? AND type='session/deleted'", [sessionId]);
      }],
      ["terminal event body generation", async (conn: Connection, sessionId: string) => {
        await conn.query(
          "UPDATE events SET body=JSON_SET(body, '$.deletionGeneration', 2) WHERE session_id=? AND type='session/deleted'",
          [sessionId],
        );
      }],
      ["missing session.tombstoned intent", async (conn: Connection, sessionId: string) => {
        await conn.query("DELETE FROM lifecycle_outbox WHERE aggregate_id=? AND topic='session.tombstoned'", [sessionId]);
      }],
      ["session.tombstoned event sequence", async (conn: Connection, sessionId: string) => {
        await conn.query(
          "UPDATE lifecycle_outbox SET payload=JSON_SET(payload, '$.eventSeq', 999) WHERE aggregate_id=? AND topic='session.tombstoned'",
          [sessionId],
        );
      }],
      ["dead-lettered session.tombstoned intent", async (conn: Connection, sessionId: string) => {
        await conn.query(
          "UPDATE lifecycle_outbox SET dead_lettered_at_ms=1 WHERE aggregate_id=? AND topic='session.tombstoned'",
          [sessionId],
        );
      }],
      ["activated session.purge intent", async (conn: Connection, sessionId: string) => {
        await conn.query("UPDATE lifecycle_outbox SET available_at_ms=1 WHERE aggregate_id=? AND topic='session.purge'", [sessionId]);
      }],
      ["attempted session.purge intent", async (conn: Connection, sessionId: string) => {
        await conn.query("UPDATE lifecycle_outbox SET attempts=1 WHERE aggregate_id=? AND topic='session.purge'", [sessionId]);
      }],
      ["claimed session.purge intent", async (conn: Connection, sessionId: string) => {
        await conn.query(
          "UPDATE lifecycle_outbox SET claim_token='unexpected', lease_until_ms=10 WHERE aggregate_id=? AND topic='session.purge'",
          [sessionId],
        );
      }],
      ["failed session.purge intent", async (conn: Connection, sessionId: string) => {
        await conn.query("UPDATE lifecycle_outbox SET last_error='unexpected' WHERE aggregate_id=? AND topic='session.purge'", [sessionId]);
      }],
      ["completed session.purge intent", async (conn: Connection, sessionId: string) => {
        await conn.query("UPDATE lifecycle_outbox SET completed_at_ms=1 WHERE aggregate_id=? AND topic='session.purge'", [sessionId]);
      }],
      ["dead-lettered session.purge intent", async (conn: Connection, sessionId: string) => {
        await conn.query("UPDATE lifecycle_outbox SET dead_lettered_at_ms=1 WHERE aggregate_id=? AND topic='session.purge'", [sessionId]);
      }],
    ] as const)("marks %s corruption as an invalid proof", async (_name, corrupt) => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(`tenant_catalog_proof_bad_${randomUUID()}`, `user_${randomUUID()}`);
      const atMs = Date.now();
      try {
        await store.createSession(session);
        await commitTombstone(store, session, atMs);
        await corrupt(conn, session.id);
        const { authority, nowMs } = await gateAndClaim(
          store,
          session.tenantId,
          session.userId,
          "reconciling_usage",
          `catalog-proof-bad-${randomUUID()}`,
          atMs + 1,
        );

        await expect(store.listErasureSessions(authority, {
          phase: "reconciling_usage",
          nowMs,
          limit: 10,
        })).resolves.toEqual({
          data: [{
            sessionId: session.id,
            deleted: true,
            deletionGeneration: 1,
            tombstoneProofValid: false,
          }],
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("throws for wrong phase and stale lease/ABA authority, and linearizes against a phase transition", async () => {
      const firstStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const secondStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const tenantId = `tenant_catalog_claim_${randomUUID()}`;
      const userId = `user_${randomUUID()}`;
      const session = mkSession(tenantId, userId);
      try {
        await firstStore.createSession(session);
        const fixture = await gateAndClaim(
          firstStore,
          tenantId,
          userId,
          "draining",
          `catalog-claim-${randomUUID()}`,
        );
        const wrongToken = { ...fixture.authority, claimToken: "different-valid-token" };
        await expect(firstStore.listErasureSessions(wrongToken, {
          phase: "draining", nowMs: fixture.nowMs, limit: 10,
        })).rejects.toThrow("stale erasure authority");
        await expect(firstStore.listErasureSessions(fixture.authority, {
          phase: "tombstoning", nowMs: fixture.nowMs, limit: 10,
        })).rejects.toThrow("stale erasure authority");
        await expect(firstStore.inspectErasureSubjectProgress(fixture.authority, {
          phase: "tombstoning", nowMs: fixture.nowMs,
        })).rejects.toThrow("stale erasure authority");

        const leaseUntilMs = fixture.claim.leaseUntilMs;
        expect((await firstStore.listErasureSessions(fixture.authority, {
          phase: "draining", nowMs: leaseUntilMs - 1, limit: 10,
        })).data).toHaveLength(1);
        await expect(firstStore.listErasureSessions(fixture.authority, {
          phase: "draining", nowMs: leaseUntilMs, limit: 10,
        })).rejects.toThrow("stale erasure authority");

        const taken = await claimRequest(
          secondStore,
          fixture.requestId,
          leaseUntilMs,
          fixture.claim.claimToken,
          600_000,
        );
        expect(taken.attempts).toBe(fixture.claim.attempts + 1);
        const takenAuthority = writeAuthorization(taken);
        await expect(firstStore.listErasureSessions(fixture.authority, {
          phase: "draining", nowMs: leaseUntilMs + 1, limit: 10,
        })).rejects.toThrow("stale erasure authority");
        expect((await secondStore.listErasureSessions(takenAuthority, {
          phase: "draining", nowMs: leaseUntilMs + 1, limit: 10,
        })).data).toHaveLength(1);

        const [catalogOutcome, transitionOutcome] = await Promise.allSettled([
          firstStore.listErasureSessions(takenAuthority, {
            phase: "draining", nowMs: leaseUntilMs + 1, limit: 10,
          }),
          secondStore.transitionErasureJob(jobAuthorization(taken), {
            fromStatus: "draining",
            toStatus: "tombstoning",
            atMs: leaseUntilMs + 2,
            availableAtMs: leaseUntilMs + 2,
          }),
        ]);
        expect(transitionOutcome).toEqual({ status: "fulfilled", value: true });
        if (catalogOutcome.status === "fulfilled") {
          expect(catalogOutcome.value.data.map((ref) => ref.sessionId)).toEqual([session.id]);
        } else {
          expect(String(catalogOutcome.reason)).toContain("stale erasure authority");
        }
      } finally {
        await secondStore.close();
        await firstStore.close();
      }
    });
  });
}
