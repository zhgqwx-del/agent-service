import { randomUUID } from "node:crypto";
import { emptyUsage, type Approval, type Item, type Session, type Turn } from "@agent-service/protocol";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LEGACY_TOMBSTONE_CUTOVER_ID,
  LegacyTombstoneChildPendingError,
  LegacyTombstoneCutoverConflictError,
  LegacyTombstoneCutoverRequiredError,
  MysqlSessionStore,
  legacyTombstoneCompensationJobIdForSession,
  newErasureRequestId,
  userErasureRequestHash,
  type ErasureJobAuthorization,
  type ErasureJobClaim,
  type ErasureRequestStatus,
  type ErasureWriteAuthorization,
  type LegacyTombstoneCompensationAuthorization,
  type LegacyTombstoneCompensationClaim,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
type Row = RowDataPacket;

interface Fixture {
  database: string;
  url: string;
  store: MysqlSessionStore;
  stores: MysqlSessionStore[];
  conn: Connection;
}

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create legacy tombstone fixture database from base database "${database}": `
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

function compensationAuthorization(
  claim: LegacyTombstoneCompensationClaim,
): LegacyTombstoneCompensationAuthorization {
  return {
    jobId: claim.jobId,
    tenantId: claim.tenantId,
    userId: claim.userId,
    sessionId: claim.sessionId,
    cutoverGeneration: claim.cutoverGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

function erasureJobAuthorization(claim: ErasureJobClaim): ErasureJobAuthorization {
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

function erasureWriteAuthorization(claim: ErasureJobClaim): ErasureWriteAuthorization {
  if (claim.subjectKind !== "user") throw new Error("test requires a user erasure claim");
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    userId: claim.subjectId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

async function createSession(
  fixture: Fixture,
  tenantId: string,
  userId: string,
  createdAtMs: number,
  parentSessionId?: string,
): Promise<Session> {
  const session: Session = {
    ...mkSession(tenantId, userId),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    createdAtMs,
    updatedAtMs: createdAtMs,
  };
  await fixture.store.createSession(session);
  return session;
}

async function markLegacy(
  fixture: Fixture,
  session: Session,
  deletedAtMs: number,
): Promise<void> {
  const [updated] = await fixture.conn.query<mysql.ResultSetHeader>(
    `UPDATE sessions
        SET deleted_at_ms=?, purge_after_ms=NULL, deletion_generation=0
      WHERE session_id=? AND tenant_id=? AND user_id=?`,
    [deletedAtMs, session.id, session.tenantId, session.userId],
  );
  expect(updated.affectedRows).toBe(1);
}

async function dropCompensationEventDeleteGuards(conn: Connection): Promise<void> {
  const [rows] = await conn.query<Row[]>(
    `SELECT TRIGGER_NAME AS trigger_name
       FROM information_schema.triggers
      WHERE TRIGGER_SCHEMA=DATABASE()
        AND EVENT_OBJECT_TABLE='legacy_tombstone_compensation_events'
        AND EVENT_MANIPULATION='DELETE'`,
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const triggerName = String(row.trigger_name);
    if (!/^trg_legacy_tombstone_compensation_events_bd(?:_guard_[ab])?$/.test(triggerName)) {
      throw new Error(`refusing to drop unexpected compensation trigger ${triggerName}`);
    }
    await conn.query(`DROP TRIGGER \`${triggerName}\``);
  }
}

async function activate(
  store: MysqlSessionStore,
  atMs: number,
  actorKeyId = "legacy-maintenance",
) {
  return store.activateLegacyTombstoneCutover({
    cutoverId: LEGACY_TOMBSTONE_CUTOVER_ID,
    expectedGeneration: 0,
    actorKeyId,
    atMs,
  });
}

async function claimCompensation(
  store: MysqlSessionStore,
  nowMs: number,
  claimToken: string,
  leaseMs = 100,
): Promise<LegacyTombstoneCompensationClaim> {
  const claim = (await store.claimLegacyTombstoneCompensations({
    nowMs,
    limit: 1,
    leaseMs,
    claimToken,
  }))[0];
  if (!claim) throw new Error("failed to claim legacy tombstone compensation fixture");
  return claim;
}

async function claimErasureRequest(
  store: MysqlSessionStore,
  requestId: string,
  nowMs: number,
  claimToken: string,
): Promise<ErasureJobClaim> {
  const claim = (await store.claimErasureJobs({
    nowMs,
    limit: 100,
    leaseMs: 1_000,
    claimToken,
  })).find((candidate) => candidate.requestId === requestId);
  if (!claim) throw new Error(`failed to claim erasure request ${requestId}`);
  return claim;
}

async function claimReconcilingUsage(
  store: MysqlSessionStore,
  session: Session,
  atMs: number,
): Promise<ErasureJobClaim> {
  const requestId = newErasureRequestId();
  await store.requestUserErasure({
    requestId,
    tenantId: session.tenantId,
    userId: session.userId,
    requestedByKeyId: "legacy-maintenance",
    idempotencyKey: `legacy-${randomUUID()}`,
    requestHash: userErasureRequestHash(session.tenantId, session.userId),
    atMs,
  });
  let nowMs = atMs;
  let claim = await claimErasureRequest(store, requestId, nowMs, "legacy-erasure-gated");
  for (const status of [
    "draining",
    "tombstoning",
    "reconciling_usage",
  ] as const satisfies readonly ErasureRequestStatus[]) {
    nowMs += 1;
    expect(await store.transitionErasureJob(erasureJobAuthorization(claim), {
      fromStatus: claim.status,
      toStatus: status,
      atMs: nowMs,
      availableAtMs: nowMs,
    })).toBe(true);
    claim = await claimErasureRequest(store, requestId, nowMs, `legacy-erasure-${status}`);
  }
  return claim;
}

async function seedActiveApproval(
  fixture: Fixture,
  session: Session,
  atMs: number,
): Promise<{ turn: Turn; approval: Approval; item: Extract<Item, { type: "approvalRequest" }> }> {
  const turn: Turn = {
    id: newId("turn"),
    sessionId: session.id,
    status: "inProgress",
    seqStart: 2,
    steps: 1,
    toolCalls: 1,
    usage: emptyUsage(),
    partialText: "historical partial text",
    startedAtMs: atMs,
  };
  const approvalId = newId("apr");
  const item: Extract<Item, { type: "approvalRequest" }> = {
    id: newId("item"),
    sessionId: session.id,
    turnId: turn.id,
    seq: 0,
    step: 1,
    status: "inProgress",
    createdAtMs: atMs,
    type: "approvalRequest",
    approvalId,
    toolCallId: "legacy-tool-call",
    name: "legacy-tool",
    args: { retainedOnlyInBusinessRow: true },
  };
  const approval: Approval = {
    id: approvalId,
    sessionId: session.id,
    turnId: turn.id,
    itemId: item.id,
    status: "pending",
    toolCallId: item.toolCallId,
    toolName: item.name,
    args: item.args,
    availableDecisions: ["accept", "decline", "cancel"],
    createdAtMs: atMs,
    expiresAtMs: atMs + 10_000,
  };
  await fixture.store.commit({
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
    sessionPatch: {
      status: { type: "active", turnId: turn.id, activeFlags: ["waitingOnApproval"] },
      autoApprovedTools: ["legacy-tool"],
    },
  });
  return { turn, approval, item };
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore legacy tombstone compensation", () => {
    let base: URL;
    let admin: Connection;
    let fixture: Fixture | undefined;
    let fixtureCounter = 0;

    async function openFixture(label: string): Promise<Fixture> {
      fixtureCounter += 1;
      const safeLabel = label.replaceAll(/[^a-z0-9]/gi, "_").slice(0, 24);
      const database = `agent_service_ltc_test_${process.pid}_${fixtureCounter}_${safeLabel}`;
      if (!/^agent_service_ltc_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe generated legacy tombstone fixture database name");
      }
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      const url = databaseUrl(base, database);
      const store = await MysqlSessionStore.connect({ url, connectionLimit: 6 });
      const conn = await mysql.createConnection(url);
      fixture = { database, url, store, stores: [store], conn };
      return fixture;
    }

    async function anotherStore(current: Fixture): Promise<MysqlSessionStore> {
      const store = await MysqlSessionStore.connect({ url: current.url, connectionLimit: 4 });
      current.stores.push(store);
      return store;
    }

    beforeAll(async () => {
      base = assertDisposableTestTarget(BASE_MYSQL_URL);
      admin = await mysql.createConnection(databaseUrl(base, "mysql"));
    });

    afterEach(async () => {
      const current = fixture;
      fixture = undefined;
      if (!current) return;
      await current.conn.end().catch(() => {});
      await Promise.all(current.stores.map((store) => store.close().catch(() => {})));
      await admin.query(`DROP DATABASE IF EXISTS \`${current.database}\``);
    });

    afterAll(async () => {
      await admin?.end();
    });

    it("activates once, globally schedules gen0 rows without erasure requests, and owner-scopes reads", async () => {
      const current = await openFixture("cutover_global");
      const now = Date.now();
      const first = await createSession(current, `tenant_${randomUUID()}`, "user-a", now);
      const second = await createSession(current, `tenant_${randomUUID()}`, "historical delegated user", now);

      expect(await current.store.getLegacyTombstoneCutover()).toBeNull();
      await expect(current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 50,
        limit: 10,
      })).rejects.toBeInstanceOf(LegacyTombstoneCutoverRequiredError);
      await expect(current.store.claimLegacyTombstoneCompensations({
        nowMs: now + 50,
        limit: 10,
        leaseMs: 100,
        claimToken: "inactive-empty-queue",
      })).rejects.toBeInstanceOf(LegacyTombstoneCutoverRequiredError);

      await markLegacy(current, first, now + 100);
      await markLegacy(current, second, now + 110);

      await expect(current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 200,
        limit: 10,
      })).rejects.toBeInstanceOf(LegacyTombstoneCutoverRequiredError);

      const activated = await activate(current.store, now + 150);
      expect(await activate(current.store, now + 150)).toEqual(activated);
      await expect(activate(current.store, now + 150, "different-actor"))
        .rejects.toBeInstanceOf(LegacyTombstoneCutoverConflictError);

      const jobs = await current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 200,
        limit: 10,
      });
      expect(jobs).toHaveLength(2);
      expect(jobs.every((job) => job.sourceKind === "maintenance")).toBe(true);
      expect(await current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 201,
        limit: 10,
      })).toEqual([]);
      const firstJob = jobs.find((job) => job.sessionId === first.id)!;
      expect(await current.store.getLegacyTombstoneCompensationJob(
        first.tenantId,
        first.userId,
        firstJob.jobId,
      )).toEqual(firstJob);
      expect(await current.store.getLegacyTombstoneCompensationJob(
        second.tenantId,
        second.userId,
        firstJob.jobId,
      )).toBeNull();
      const [requestCount] = await current.conn.query<(Row & { count: number })[]>(
        "SELECT COUNT(*) AS count FROM erasure_requests",
      );
      expect(Number(requestCount[0]?.count)).toBe(0);
    });

    it("globally isolates a corrupt session candidate and still completes its healthy neighbour", async () => {
      const current = await openFixture("candidate_poison_neighbor");
      const now = Date.now();
      const poison = await createSession(current, `tenant_${randomUUID()}`, "poison-user", now);
      const neighbor = await createSession(current, `tenant_${randomUUID()}`, "healthy-user", now);
      await markLegacy(current, poison, now + 100);
      await markLegacy(current, neighbor, now + 100);
      await current.conn.query(
        "UPDATE sessions SET updated_at_ms=? WHERE session_id=?",
        [now + 101, poison.id],
      );
      await activate(current.store, now + 150);

      const jobs = await current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 200,
        limit: 2,
      });
      expect(jobs.map((job) => job.sessionId)).toEqual([neighbor.id]);
      const poisonJobId = legacyTombstoneCompensationJobIdForSession(poison.id);
      expect(await current.store.getLegacyTombstoneCompensationJob(
        poison.tenantId,
        poison.userId,
        poisonJobId,
      )).toMatchObject({
        sessionId: poison.id,
        status: "terminal_incident",
        terminalReasonCode: "session_integrity_conflict",
      });
      expect(await current.store.listLegacyTombstoneCompensationAudits(poisonJobId)).toEqual([
        expect.objectContaining({
          type: "legacy_tombstone/terminal_incident",
          reasonCode: "session_integrity_conflict",
        }),
      ]);

      const neighborClaim = await claimCompensation(
        current.store,
        now + 200,
        "candidate-neighbor-worker",
      );
      expect(neighborClaim.sessionId).toBe(neighbor.id);
      expect(await current.store.completeLegacyTombstoneCompensation(
        compensationAuthorization(neighborClaim),
        { completedAtMs: now + 201 },
      )).toMatchObject({ outcome: "compensated", sessionId: neighbor.id });
      expect(await current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 202,
        limit: 10,
      })).toEqual([]);
      expect(await current.store.listLegacyTombstoneCompensationAudits(poisonJobId)).toHaveLength(1);
    });

    it("targeted scheduling replays across erasure claim attempts without rewriting first-source proof", async () => {
      const current = await openFixture("targeted_replay");
      const now = Date.now();
      const target = await createSession(current, `tenant_${randomUUID()}`, "target-user", now);
      const neighbor = await createSession(current, target.tenantId, "neighbor-user", now);
      await markLegacy(current, target, now + 100);
      await markLegacy(current, neighbor, now + 100);
      await activate(current.store, now + 150);
      const sourceClaim = await claimReconcilingUsage(current.store, target, now + 200);
      const input = {
        jobId: legacyTombstoneCompensationJobIdForSession(target.id),
        sessionId: target.id,
        atMs: now + 210,
        availableAtMs: now + 210,
      };

      await expect(current.store.scheduleLegacyTombstoneCompensation(
        erasureWriteAuthorization(sourceClaim),
        {
          ...input,
          jobId: legacyTombstoneCompensationJobIdForSession(neighbor.id),
          sessionId: neighbor.id,
        },
      )).rejects.toThrow();
      const first = await current.store.scheduleLegacyTombstoneCompensation(
        erasureWriteAuthorization(sourceClaim),
        input,
      );
      expect(first).toMatchObject({
        sourceKind: "erasure_claim",
        sourceRequestId: sourceClaim.requestId,
        sourceSubjectGeneration: sourceClaim.subjectGeneration,
        sourceClaimAttempt: sourceClaim.attempts,
      });

      expect(await current.store.retryErasureJob(erasureJobAuthorization(sourceClaim), {
        failedAtMs: now + 211,
        availableAtMs: now + 212,
        errorCode: "legacy_compensation_pending",
      })).toBe(true);
      const replacement = await claimErasureRequest(
        current.store,
        sourceClaim.requestId,
        now + 212,
        "legacy-erasure-replacement",
      );
      expect(replacement.attempts).toBe(sourceClaim.attempts + 1);
      expect(await current.store.scheduleLegacyTombstoneCompensation(
        erasureWriteAuthorization(replacement),
        { ...input, atMs: now + 213, availableAtMs: now + 300 },
      )).toEqual(first);
    });

    it("projects a pending targeted job with an existing result as terminal proof conflict", async () => {
      const current = await openFixture("targeted_result_projection");
      const now = Date.now();
      const session = await createSession(current, `tenant_${randomUUID()}`, "target-user", now);
      await markLegacy(current, session, now + 100);
      await activate(current.store, now + 150);
      const sourceClaim = await claimReconcilingUsage(current.store, session, now + 200);
      const input = {
        jobId: legacyTombstoneCompensationJobIdForSession(session.id),
        sessionId: session.id,
        atMs: now + 210,
        availableAtMs: now + 210,
      };
      const pending = await current.store.scheduleLegacyTombstoneCompensation(
        erasureWriteAuthorization(sourceClaim),
        input,
      );
      expect(pending.status).toBe("pending");
      const [jobRows] = await current.conn.query<Row[]>(
        `SELECT candidate_sha256, source_deleted_at_ms
           FROM legacy_tombstone_compensation_jobs WHERE job_id=?`,
        [pending.jobId],
      );
      await current.conn.query(
        `INSERT INTO legacy_tombstone_compensation_events
           (job_id, session_id, control_generation, event_type, reason_code, actor_key_id,
            claim_attempt, source_deleted_at_ms, target_deletion_generation, terminal_event_seq,
            before_sha256, after_sha256, emitted_at_ms)
         VALUES (?, ?, 1, 'legacy_tombstone/terminal_incident', 'proof_conflict', NULL,
                 NULL, ?, NULL, NULL, ?, ?, ?)`,
        [
          pending.jobId,
          session.id,
          jobRows[0]!.source_deleted_at_ms,
          String(jobRows[0]!.candidate_sha256),
          "b".repeat(64),
          now + 211,
        ],
      );

      const projected = await current.store.scheduleLegacyTombstoneCompensation(
        erasureWriteAuthorization(sourceClaim),
        { ...input, atMs: now + 212, availableAtMs: now + 300 },
      );
      expect(projected).toMatchObject({
        jobId: pending.jobId,
        sourceKind: "erasure_claim",
        status: "terminal_incident",
        terminalReasonCode: "proof_conflict",
      });
      expect(projected).not.toHaveProperty("availableAtMs");
      expect(await current.store.getLegacyTombstoneCompensationJob(
        session.tenantId,
        session.userId,
        pending.jobId,
      )).toEqual(projected);
      const [storedRows] = await current.conn.query<Row[]>(
        "SELECT status FROM legacy_tombstone_compensation_jobs WHERE job_id=?",
        [pending.jobId],
      );
      expect(storedRows[0]?.status).toBe("pending");
      expect(await current.store.claimLegacyTombstoneCompensations({
        nowMs: now + 212,
        limit: 1,
        leaseMs: 100,
        claimToken: "must-not-claim-result-backed-pending",
      })).toEqual([]);
    });

    it("uses token plus attempt for claim concurrency and ABA, then publishes once under concurrent completion", async () => {
      const current = await openFixture("claim_aba_success");
      const other = await anotherStore(current);
      const now = Date.now();
      const session = await createSession(current, `tenant_${randomUUID()}`, "aba-user", now);
      const deletedAtMs = now + 100;
      await markLegacy(current, session, deletedAtMs);
      await activate(current.store, now + 150);
      await current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 200,
        limit: 1,
      });

      const [firstRace, secondRace] = await Promise.all([
        current.store.claimLegacyTombstoneCompensations({
          nowMs: now + 200,
          limit: 1,
          leaseMs: 10,
          claimToken: "reused-token",
        }),
        other.claimLegacyTombstoneCompensations({
          nowMs: now + 200,
          limit: 1,
          leaseMs: 10,
          claimToken: "competing-token",
        }),
      ]);
      expect([firstRace.length, secondRace.length].sort()).toEqual([0, 1]);
      const first = (firstRace[0] ?? secondRace[0])!;
      expect(await current.store.renewLegacyTombstoneCompensation(
        compensationAuthorization(first),
        { nowMs: now + 201, leaseMs: 1 },
      )).toBe(true);
      const [shortRenewRows] = await current.conn.query<Row[]>(
        "SELECT lease_until_ms FROM legacy_tombstone_compensation_jobs WHERE job_id=?",
        [first.jobId],
      );
      expect(Number(shortRenewRows[0]?.lease_until_ms)).toBe(now + 210);
      const replacement = await claimCompensation(
        current.store,
        now + 210,
        "reused-token",
        30,
      );
      expect(replacement.attempts).toBe(2);
      expect(await current.store.renewLegacyTombstoneCompensation(
        compensationAuthorization(first),
        { nowMs: now + 211, leaseMs: 100 },
      )).toBe(false);
      expect(await current.store.retryLegacyTombstoneCompensation(
        compensationAuthorization(first),
        {
          failedAtMs: now + 211,
          availableAtMs: now + 212,
          errorCode: "temporary_failure",
        },
      )).toBe(false);
      expect(await current.store.completeLegacyTombstoneCompensation(
        compensationAuthorization(first),
        { completedAtMs: now + 211 },
      )).toBeNull();
      expect(await current.store.renewLegacyTombstoneCompensation(
        compensationAuthorization(replacement),
        { nowMs: now + 211, leaseMs: 50 },
      )).toBe(true);
      expect(await current.store.retryLegacyTombstoneCompensation(
        compensationAuthorization(replacement),
        {
          failedAtMs: now + 212,
          availableAtMs: now + 220,
          errorCode: "owner_unavailable",
        },
      )).toBe(true);
      expect(await current.store.claimLegacyTombstoneCompensations({
        nowMs: now + 219,
        limit: 1,
        leaseMs: 50,
        claimToken: "too-early",
      })).toEqual([]);
      const finalClaim = await claimCompensation(current.store, now + 220, "final-owner", 100);
      expect(finalClaim.attempts).toBe(3);

      const authorization = compensationAuthorization(finalClaim);
      const [one, two] = await Promise.all([
        current.store.completeLegacyTombstoneCompensation(authorization, {
          completedAtMs: now + 221,
        }),
        other.completeLegacyTombstoneCompensation(authorization, {
          completedAtMs: now + 221,
        }),
      ]);
      expect([one?.outcome, two?.outcome].sort()).toEqual([
        "already_compensated",
        "compensated",
      ]);
      expect(await current.store.completeLegacyTombstoneCompensation(authorization, {
        completedAtMs: now + 999,
      })).toMatchObject({ outcome: "already_compensated", eventSeq: 2 });

      const [sessionRows] = await current.conn.query<Row[]>(
        `SELECT deleted_at_ms, deletion_generation, purge_after_ms, last_seq
           FROM sessions WHERE session_id=?`,
        [session.id],
      );
      expect({
        deletedAtMs: Number(sessionRows[0]?.deleted_at_ms),
        deletionGeneration: Number(sessionRows[0]?.deletion_generation),
        purgeAfterMs: sessionRows[0]?.purge_after_ms,
        lastSeq: Number(sessionRows[0]?.last_seq),
      }).toEqual({
        deletedAtMs,
        deletionGeneration: 1,
        purgeAfterMs: null,
        lastSeq: 2,
      });
      const [eventRows] = await current.conn.query<Row[]>(
        "SELECT seq, type, emitted_at_ms, body FROM events WHERE session_id=? ORDER BY seq",
        [session.id],
      );
      expect(eventRows.map((row) => [Number(row.seq), row.type, Number(row.emitted_at_ms)]))
        .toEqual([[1, "session/created", now], [2, "session/deleted", deletedAtMs]]);
      const terminalBody = typeof eventRows[1]?.body === "string"
        ? JSON.parse(eventRows[1].body)
        : eventRows[1]?.body;
      expect(terminalBody).toMatchObject({ deletionGeneration: 1, emittedAtMs: deletedAtMs });
      const [outboxRows] = await current.conn.query<Row[]>(
        `SELECT topic, payload, available_at_ms, completed_at_ms, dead_lettered_at_ms
           FROM lifecycle_outbox WHERE aggregate_id=? ORDER BY topic`,
        [session.id],
      );
      expect(outboxRows.map((row) => row.topic)).toEqual(["session.purge", "session.tombstoned"]);
      expect(outboxRows.find((row) => row.topic === "session.purge")?.available_at_ms).toBeNull();
      expect(outboxRows.every((row) => row.completed_at_ms == null && row.dead_lettered_at_ms == null))
        .toBe(true);
      expect(await current.store.listLegacyTombstoneCompensationAudits(finalClaim.jobId))
        .toEqual([expect.objectContaining({
          type: "legacy_tombstone/compensated",
          sessionId: session.id,
          eventSeq: 2,
          claimAttempt: 3,
        })]);
    });

    it("fixed-settles an active turn and pending approval in the same success publication", async () => {
      const current = await openFixture("active_settlement");
      const now = Date.now();
      const session = await createSession(current, `tenant_${randomUUID()}`, "active-user", now);
      const resources = await seedActiveApproval(current, session, now + 10);
      const deletedAtMs = now + 100;
      await markLegacy(current, session, deletedAtMs);
      await activate(current.store, now + 150);
      await current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 200,
        limit: 1,
      });
      const claim = await claimCompensation(current.store, now + 200, "active-worker");
      expect(await current.store.completeLegacyTombstoneCompensation(
        compensationAuthorization(claim),
        { completedAtMs: now + 201 },
      )).toMatchObject({ outcome: "compensated", eventSeq: 9 });

      const [turnRows] = await current.conn.query<Row[]>(
        "SELECT status, stop_reason, completed_at_ms, body FROM turns WHERE turn_id=?",
        [resources.turn.id],
      );
      const turnBody = typeof turnRows[0]?.body === "string"
        ? JSON.parse(turnRows[0].body)
        : turnRows[0]?.body;
      expect(turnRows[0]).toMatchObject({ status: "interrupted", stop_reason: "interrupted" });
      expect(Number(turnRows[0]?.completed_at_ms)).toBe(deletedAtMs);
      expect(turnBody).toMatchObject({ error: { code: "legacy_tombstone_compensation" } });
      const [approvalRows] = await current.conn.query<Row[]>(
        "SELECT status, body FROM approvals WHERE approval_id=?",
        [resources.approval.id],
      );
      const approvalBody = typeof approvalRows[0]?.body === "string"
        ? JSON.parse(approvalRows[0].body)
        : approvalRows[0]?.body;
      expect(approvalRows[0]?.status).toBe("expired");
      expect(approvalBody).toMatchObject({
        status: "expired",
        decision: "cancel",
        decidedBy: "system:erasure",
        resolvedAtMs: deletedAtMs,
      });
      const [itemRows] = await current.conn.query<Row[]>(
        "SELECT status, completed_at_ms FROM items WHERE item_id=?",
        [resources.item.id],
      );
      expect(itemRows[0]?.status).toBe("declined");
      expect(Number(itemRows[0]?.completed_at_ms)).toBe(deletedAtMs);
      const [eventRows] = await current.conn.query<Row[]>(
        "SELECT type FROM events WHERE session_id=? AND seq>=5 ORDER BY seq",
        [session.id],
      );
      expect(eventRows.map((row) => row.type)).toEqual([
        "approval/resolved",
        "item/completed",
        "turn/completed",
        "session/status/changed",
        "session/deleted",
      ]);
      const [sessionRows] = await current.conn.query<Row[]>(
        `SELECT status, deleted_at_ms, deletion_generation, purge_after_ms, last_seq
           FROM sessions WHERE session_id=?`,
        [session.id],
      );
      const sessionStatus = typeof sessionRows[0]?.status === "string"
        ? JSON.parse(sessionRows[0].status)
        : sessionRows[0]?.status;
      expect({
        status: sessionStatus,
        deletedAtMs: Number(sessionRows[0]?.deleted_at_ms),
        generation: Number(sessionRows[0]?.deletion_generation),
        purgeAfterMs: sessionRows[0]?.purge_after_ms,
        lastSeq: Number(sessionRows[0]?.last_seq),
      }).toEqual({
        status: { type: "idle" },
        deletedAtMs,
        generation: 1,
        purgeAfterMs: null,
        lastSeq: 9,
      });
      const [outboxRows] = await current.conn.query<Row[]>(
        `SELECT topic, payload, available_at_ms
           FROM lifecycle_outbox WHERE aggregate_id=? AND generation=1 ORDER BY topic`,
        [session.id],
      );
      expect(outboxRows.map((row) => row.topic)).toEqual(["session.purge", "session.tombstoned"]);
      const purge = outboxRows.find((row) => row.topic === "session.purge")!;
      const tombstoned = outboxRows.find((row) => row.topic === "session.tombstoned")!;
      expect(purge.available_at_ms).toBeNull();
      expect(typeof purge.payload === "string" ? JSON.parse(purge.payload) : purge.payload)
        .toEqual({ sessionId: session.id, deletionGeneration: 1 });
      expect(typeof tombstoned.payload === "string" ? JSON.parse(tombstoned.payload) : tombstoned.payload)
        .toEqual({ sessionId: session.id, deletionGeneration: 1, eventSeq: 9 });
    });

    it("rolls every success write back on an injected audit failure and retries safely", async () => {
      const current = await openFixture("rollback");
      const now = Date.now();
      const session = await createSession(current, `tenant_${randomUUID()}`, "rollback-user", now);
      await markLegacy(current, session, now + 100);
      await activate(current.store, now + 150);
      await current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 200,
        limit: 1,
      });
      const claim = await claimCompensation(current.store, now + 200, "rollback-worker");
      const authorization = compensationAuthorization(claim);
      await current.conn.query(
        `CREATE TRIGGER fail_legacy_tombstone_audit
           BEFORE INSERT ON legacy_tombstone_compensation_events
           FOR EACH ROW SIGNAL SQLSTATE '45000'
             SET MESSAGE_TEXT='injected legacy tombstone audit failure'`,
      );
      await expect(current.store.completeLegacyTombstoneCompensation(authorization, {
        completedAtMs: now + 201,
      })).rejects.toThrow("injected legacy tombstone audit failure");

      const [counts] = await current.conn.query<(Row & {
        generation: number;
        lastSeq: number;
        events: number;
        outboxes: number;
        audits: number;
      })[]>(
        `SELECT s.deletion_generation AS generation, s.last_seq AS lastSeq,
                (SELECT COUNT(*) FROM events e WHERE e.session_id=s.session_id) AS events,
                (SELECT COUNT(*) FROM lifecycle_outbox o WHERE o.aggregate_id=s.session_id) AS outboxes,
                (SELECT COUNT(*) FROM legacy_tombstone_compensation_events a
                  WHERE a.job_id=?) AS audits
           FROM sessions s WHERE s.session_id=?`,
        [claim.jobId, session.id],
      );
      expect({
        generation: Number(counts[0]?.generation),
        lastSeq: Number(counts[0]?.lastSeq),
        events: Number(counts[0]?.events),
        outboxes: Number(counts[0]?.outboxes),
        audits: Number(counts[0]?.audits),
      }).toEqual({ generation: 0, lastSeq: 1, events: 1, outboxes: 0, audits: 0 });
      expect(await current.store.getLegacyTombstoneCompensationJob(
        session.tenantId,
        session.userId,
        claim.jobId,
      )).toMatchObject({
        status: "pending",
        attempts: 1,
        claimToken: "rollback-worker",
      });

      await current.conn.query("DROP TRIGGER fail_legacy_tombstone_audit");
      expect(await current.store.completeLegacyTombstoneCompensation(authorization, {
        completedAtMs: now + 202,
      })).toMatchObject({ outcome: "compensated", eventSeq: 2 });
      expect(await current.store.completeLegacyTombstoneCompensation(authorization, {
        completedAtMs: now + 203,
      })).toMatchObject({ outcome: "already_compensated", eventSeq: 2 });
    });

    it("isolates completed and terminal jobs missing their result once, then claims the neighbour", async () => {
      const current = await openFixture("missing_result_neighbor");
      const now = Date.now();
      const completedSession = await createSession(
        current,
        `tenant_${randomUUID()}`,
        "completed-user",
        now,
      );
      const terminalSession = await createSession(
        current,
        `tenant_${randomUUID()}`,
        "terminal-user",
        now,
      );
      const corruptTerminalSession = await createSession(
        current,
        `tenant_${randomUUID()}`,
        "corrupt-terminal-user",
        now,
      );
      const neighbor = await createSession(
        current,
        `tenant_${randomUUID()}`,
        "neighbor-user",
        now,
      );
      await markLegacy(current, completedSession, now + 100);
      await markLegacy(current, terminalSession, now + 100);
      await markLegacy(current, corruptTerminalSession, now + 100);
      await markLegacy(current, neighbor, now + 100);
      // Seed a pre-cutover deterministic candidate fault so this fixture owns one real terminal row.
      await current.conn.query(
        "UPDATE sessions SET purge_after_ms=? WHERE session_id=?",
        [now + 1_000, terminalSession.id],
      );
      await activate(current.store, now + 150);
      const jobs = await current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 200,
        limit: 10,
      });
      const completedJob = jobs.find((job) => job.sessionId === completedSession.id)!;
      const corruptTerminalJob = jobs.find((job) => job.sessionId === corruptTerminalSession.id)!;
      const neighborJob = jobs.find((job) => job.sessionId === neighbor.id)!;
      const terminalJobId = legacyTombstoneCompensationJobIdForSession(terminalSession.id);
      expect(completedJob).toBeDefined();
      expect(corruptTerminalJob).toBeDefined();
      expect(neighborJob).toBeDefined();
      expect(await current.store.getLegacyTombstoneCompensationJob(
        terminalSession.tenantId,
        terminalSession.userId,
        terminalJobId,
      )).toMatchObject({ status: "terminal_incident" });

      await current.conn.query(
        `UPDATE legacy_tombstone_compensation_jobs SET available_at_ms=?
          WHERE job_id IN (?, ?)`,
        [now + 300, neighborJob.jobId, corruptTerminalJob.jobId],
      );
      const completedClaim = await claimCompensation(
        current.store,
        now + 200,
        "completed-worker",
      );
      expect(completedClaim.sessionId).toBe(completedSession.id);
      expect(await current.store.completeLegacyTombstoneCompensation(
        compensationAuthorization(completedClaim),
        { completedAtMs: now + 201 },
      )).toMatchObject({ outcome: "compensated" });

      // Simulate storage-level evidence loss. Production guards are intentionally removed only in
      // this disposable database; the runtime must fail closed instead of reviving either job.
      await dropCompensationEventDeleteGuards(current.conn);
      const [deleted] = await current.conn.query<mysql.ResultSetHeader>(
        `DELETE FROM legacy_tombstone_compensation_events WHERE job_id IN (?, ?)`,
        [completedJob.jobId, terminalJobId],
      );
      expect(deleted.affectedRows).toBe(2);
      // Both corrupt rows deliberately have a legal, finite non-NULL availability. A candidate
      // query that only looks for invalid timestamps or unknown statuses will silently miss them.
      await current.conn.query(
        `UPDATE legacy_tombstone_compensation_jobs
            SET available_at_ms=?, completed_event_seq=NULL
          WHERE job_id=?`,
        [now + 900, completedJob.jobId],
      );
      await current.conn.query(
        `UPDATE legacy_tombstone_compensation_jobs
            SET status='terminal_incident', available_at_ms=?, claim_token=NULL,
                lease_until_ms=NULL, terminal_at_ms=NULL, terminal_reason_code=NULL,
                terminal_evidence_sha256=NULL
          WHERE job_id=?`,
        [now + 901, corruptTerminalJob.jobId],
      );
      await current.conn.query(
        "UPDATE legacy_tombstone_compensation_jobs SET available_at_ms=? WHERE job_id=?",
        [now + 250, neighborJob.jobId],
      );

      const claims = await current.store.claimLegacyTombstoneCompensations({
        nowMs: now + 250,
        limit: 10,
        leaseMs: 100,
        claimToken: "missing-result-neighbor",
      });
      expect(claims).toHaveLength(1);
      expect(claims[0]?.sessionId).toBe(neighbor.id);
      for (const [session, jobId] of [
        [completedSession, completedJob.jobId],
        [corruptTerminalSession, corruptTerminalJob.jobId],
      ] as const) {
        expect(await current.store.listLegacyTombstoneCompensationAudits(jobId)).toEqual([
          expect.objectContaining({
            type: "legacy_tombstone/terminal_incident",
            reasonCode: "unsafe_job_envelope",
          }),
        ]);
        expect(await current.store.getLegacyTombstoneCompensationJob(
          session.tenantId,
          session.userId,
          jobId,
        )).toMatchObject({
          status: "terminal_incident",
          terminalReasonCode: "unsafe_job_envelope",
        });
      }
      expect(await current.store.listLegacyTombstoneCompensationAudits(terminalJobId)).toEqual([
        expect.objectContaining({
          type: "legacy_tombstone/terminal_incident",
          reasonCode: "proof_conflict",
        }),
      ]);
      expect(await current.store.getLegacyTombstoneCompensationJob(
        terminalSession.tenantId,
        terminalSession.userId,
        terminalJobId,
      )).toMatchObject({
        status: "terminal_incident",
        terminalReasonCode: "proof_conflict",
      });
      expect(await current.store.claimLegacyTombstoneCompensations({
        nowMs: now + 251,
        limit: 10,
        leaseMs: 100,
        claimToken: "must-not-reisolate",
      })).toEqual([]);
      expect(await current.store.listLegacyTombstoneCompensationAudits(completedJob.jobId))
        .toHaveLength(1);
      expect(await current.store.listLegacyTombstoneCompensationAudits(corruptTerminalJob.jobId))
        .toHaveLength(1);
      expect(await current.store.listLegacyTombstoneCompensationAudits(terminalJobId))
        .toHaveLength(1);
    });

    it("terminally isolates an unsafe job envelope and still claims its healthy neighbour", async () => {
      const current = await openFixture("poison_neighbor");
      const now = Date.now();
      const first = await createSession(current, `tenant_${randomUUID()}`, "poison-user", now);
      const second = await createSession(current, `tenant_${randomUUID()}`, "healthy-user", now);
      await markLegacy(current, first, now + 100);
      await markLegacy(current, second, now + 100);
      await activate(current.store, now + 150);
      const jobs = await current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 200,
        limit: 2,
      });
      const ordered = jobs.toSorted((a, b) => a.jobId.localeCompare(b.jobId));
      await current.conn.query(
        "UPDATE legacy_tombstone_compensation_jobs SET available_at_ms=? WHERE job_id=?",
        ["9007199254740992", ordered[0]!.jobId],
      );

      const claims = await current.store.claimLegacyTombstoneCompensations({
        nowMs: now + 200,
        limit: 1,
        leaseMs: 100,
        claimToken: "healthy-worker",
      });
      expect(claims).toHaveLength(1);
      expect(claims[0]?.jobId).toBe(ordered[1]?.jobId);
      expect(await current.store.listLegacyTombstoneCompensationAudits(ordered[0]!.jobId))
        .toEqual([expect.objectContaining({
          type: "legacy_tombstone/terminal_incident",
          reasonCode: "unsafe_job_envelope",
        })]);
      const [poisonRows] = await current.conn.query<Row[]>(
        `SELECT status, available_at_ms FROM legacy_tombstone_compensation_jobs WHERE job_id=?`,
        [ordered[0]!.jobId],
      );
      expect(poisonRows[0]?.status).toBe("pending");
      expect(String(poisonRows[0]?.available_at_ms)).toBe("9007199254740992");
    });

    it("enforces child-first completion and lets the parent resume after the child succeeds", async () => {
      const current = await openFixture("child_first");
      const now = Date.now();
      const parent = await createSession(current, `tenant_${randomUUID()}`, "tree-user", now);
      const child = await createSession(current, parent.tenantId, parent.userId, now + 1, parent.id);
      await markLegacy(current, parent, now + 100);
      await markLegacy(current, child, now + 110);
      await activate(current.store, now + 150);

      const childJobs = await current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 200,
        limit: 1,
      });
      expect(childJobs.map((job) => job.sessionId)).toEqual([child.id]);
      const parentJobs = await current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 200,
        limit: 1,
      });
      expect(parentJobs.map((job) => job.sessionId)).toEqual([parent.id]);
      await current.conn.query(
        "UPDATE legacy_tombstone_compensation_jobs SET available_at_ms=? WHERE job_id=?",
        [now + 210, childJobs[0]!.jobId],
      );

      const parentClaim = await claimCompensation(current.store, now + 200, "parent-worker", 100);
      expect(parentClaim.sessionId).toBe(parent.id);
      await expect(current.store.completeLegacyTombstoneCompensation(
        compensationAuthorization(parentClaim),
        { completedAtMs: now + 201 },
      )).rejects.toBeInstanceOf(LegacyTombstoneChildPendingError);
      const childClaim = await claimCompensation(current.store, now + 210, "child-worker", 100);
      expect(childClaim.sessionId).toBe(child.id);
      expect(await current.store.completeLegacyTombstoneCompensation(
        compensationAuthorization(childClaim),
        { completedAtMs: now + 211 },
      )).toMatchObject({ outcome: "compensated", sessionId: child.id });
      expect(await current.store.completeLegacyTombstoneCompensation(
        compensationAuthorization(parentClaim),
        { completedAtMs: now + 212 },
      )).toMatchObject({ outcome: "compensated", sessionId: parent.id });
    });

    it("terminally isolates a parent whose gen0 child already has a durable terminal result", async () => {
      const current = await openFixture("terminal_child_parent");
      const now = Date.now();
      const parent = await createSession(current, `tenant_${randomUUID()}`, "tree-user", now);
      const child = await createSession(current, parent.tenantId, parent.userId, now + 1, parent.id);
      const neighbor = await createSession(
        current,
        `tenant_${randomUUID()}`,
        "unrelated-user",
        now,
      );
      const parentDeletedAtMs = now + 100;
      await markLegacy(current, parent, parentDeletedAtMs);
      await markLegacy(current, child, now + 110);
      await markLegacy(current, neighbor, now + 100);
      // The child remains generation zero but is deterministically unsafe. The sweep must retain
      // its terminal result and must not let the fallback parent retry forever as child_pending.
      await current.conn.query(
        "UPDATE sessions SET updated_at_ms=? WHERE session_id=?",
        [now + 111, child.id],
      );
      await activate(current.store, now + 150);

      const jobs = await current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 200,
        limit: 3,
      });
      const parentJob = jobs.find((job) => job.sessionId === parent.id)!;
      const neighborJob = jobs.find((job) => job.sessionId === neighbor.id)!;
      const childJobId = legacyTombstoneCompensationJobIdForSession(child.id);
      expect(parentJob).toBeDefined();
      expect(neighborJob).toBeDefined();
      expect(await current.store.getLegacyTombstoneCompensationJob(
        child.tenantId,
        child.userId,
        childJobId,
      )).toMatchObject({
        status: "terminal_incident",
        terminalReasonCode: "session_integrity_conflict",
      });
      expect(await current.store.listLegacyTombstoneCompensationAudits(childJobId)).toEqual([
        expect.objectContaining({
          type: "legacy_tombstone/terminal_incident",
          reasonCode: "session_integrity_conflict",
        }),
      ]);

      await current.conn.query(
        "UPDATE legacy_tombstone_compensation_jobs SET available_at_ms=? WHERE job_id=?",
        [now + 300, neighborJob.jobId],
      );
      const parentClaim = await claimCompensation(
        current.store,
        now + 200,
        "terminal-child-parent-worker",
      );
      expect(parentClaim.sessionId).toBe(parent.id);
      const parentAuthorization = compensationAuthorization(parentClaim);
      expect(await current.store.completeLegacyTombstoneCompensation(
        parentAuthorization,
        { completedAtMs: now + 201 },
      )).toMatchObject({
        outcome: "terminal_incident",
        reasonCode: "child_dependency_invalid",
      });
      expect(await current.store.completeLegacyTombstoneCompensation(
        parentAuthorization,
        { completedAtMs: now + 202 },
      )).toBeNull();

      const [parentRows] = await current.conn.query<Row[]>(
        `SELECT deleted_at_ms, deletion_generation, last_seq
           FROM sessions WHERE session_id=?`,
        [parent.id],
      );
      expect({
        deletedAtMs: Number(parentRows[0]?.deleted_at_ms),
        deletionGeneration: Number(parentRows[0]?.deletion_generation),
        lastSeq: Number(parentRows[0]?.last_seq),
      }).toEqual({
        deletedAtMs: parentDeletedAtMs,
        deletionGeneration: 0,
        lastSeq: 1,
      });
      const [parentPublication] = await current.conn.query<(Row & {
        events: number;
        outboxes: number;
      })[]>(
        `SELECT
           (SELECT COUNT(*) FROM events WHERE session_id=?) AS events,
           (SELECT COUNT(*) FROM lifecycle_outbox WHERE aggregate_id=?) AS outboxes`,
        [parent.id, parent.id],
      );
      expect({
        events: Number(parentPublication[0]?.events),
        outboxes: Number(parentPublication[0]?.outboxes),
      }).toEqual({ events: 1, outboxes: 0 });

      await current.conn.query(
        "UPDATE legacy_tombstone_compensation_jobs SET available_at_ms=? WHERE job_id=?",
        [now + 203, neighborJob.jobId],
      );
      const neighborClaim = await claimCompensation(
        current.store,
        now + 203,
        "terminal-child-neighbor-worker",
      );
      expect(neighborClaim.sessionId).toBe(neighbor.id);
      expect(await current.store.completeLegacyTombstoneCompensation(
        compensationAuthorization(neighborClaim),
        { completedAtMs: now + 204 },
      )).toMatchObject({ outcome: "compensated", sessionId: neighbor.id });
    });

    it("terminally isolates a legacy parent with a still-live direct child without partial writes", async () => {
      const current = await openFixture("live_child_parent");
      const now = Date.now();
      const parent = await createSession(current, `tenant_${randomUUID()}`, "tree-user", now);
      const liveChild = await createSession(
        current,
        parent.tenantId,
        parent.userId,
        now + 1,
        parent.id,
      );
      const neighbor = await createSession(
        current,
        `tenant_${randomUUID()}`,
        "unrelated-user",
        now,
      );
      const parentDeletedAtMs = now + 100;
      await markLegacy(current, parent, parentDeletedAtMs);
      await markLegacy(current, neighbor, now + 100);
      await activate(current.store, now + 150);

      const jobs = await current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 200,
        limit: 2,
      });
      const parentJob = jobs.find((job) => job.sessionId === parent.id)!;
      const neighborJob = jobs.find((job) => job.sessionId === neighbor.id)!;
      expect(parentJob).toBeDefined();
      expect(neighborJob).toBeDefined();
      expect(await current.store.getLegacyTombstoneCompensationJob(
        liveChild.tenantId,
        liveChild.userId,
        legacyTombstoneCompensationJobIdForSession(liveChild.id),
      )).toBeNull();

      await current.conn.query(
        "UPDATE legacy_tombstone_compensation_jobs SET available_at_ms=? WHERE job_id=?",
        [now + 300, neighborJob.jobId],
      );
      const parentClaim = await claimCompensation(
        current.store,
        now + 200,
        "live-child-parent-worker",
      );
      expect(parentClaim.sessionId).toBe(parent.id);
      const parentAuthorization = compensationAuthorization(parentClaim);
      expect(await current.store.completeLegacyTombstoneCompensation(
        parentAuthorization,
        { completedAtMs: now + 201 },
      )).toMatchObject({
        outcome: "terminal_incident",
        reasonCode: "child_dependency_invalid",
      });
      expect(await current.store.completeLegacyTombstoneCompensation(
        parentAuthorization,
        { completedAtMs: now + 202 },
      )).toBeNull();

      const [parentRows] = await current.conn.query<Row[]>(
        `SELECT deleted_at_ms, deletion_generation, last_seq
           FROM sessions WHERE session_id=?`,
        [parent.id],
      );
      expect({
        deletedAtMs: Number(parentRows[0]?.deleted_at_ms),
        deletionGeneration: Number(parentRows[0]?.deletion_generation),
        lastSeq: Number(parentRows[0]?.last_seq),
      }).toEqual({
        deletedAtMs: parentDeletedAtMs,
        deletionGeneration: 0,
        lastSeq: 1,
      });
      const [parentPublication] = await current.conn.query<(Row & {
        events: number;
        outboxes: number;
      })[]>(
        `SELECT
           (SELECT COUNT(*) FROM events WHERE session_id=?) AS events,
           (SELECT COUNT(*) FROM lifecycle_outbox WHERE aggregate_id=?) AS outboxes`,
        [parent.id, parent.id],
      );
      expect({
        events: Number(parentPublication[0]?.events),
        outboxes: Number(parentPublication[0]?.outboxes),
      }).toEqual({ events: 1, outboxes: 0 });

      await current.conn.query(
        "UPDATE legacy_tombstone_compensation_jobs SET available_at_ms=? WHERE job_id=?",
        [now + 203, neighborJob.jobId],
      );
      const neighborClaim = await claimCompensation(
        current.store,
        now + 203,
        "live-child-neighbor-worker",
      );
      expect(neighborClaim.sessionId).toBe(neighbor.id);
      expect(await current.store.completeLegacyTombstoneCompensation(
        compensationAuthorization(neighborClaim),
        { completedAtMs: now + 204 },
      )).toMatchObject({ outcome: "compensated", sessionId: neighbor.id });
    });

    it("terminally isolates cross-owner children and ancestry cycles without fabricating completion", async () => {
      const current = await openFixture("owner_cycle");
      const now = Date.now();

      const ownerParent = await createSession(current, `tenant_${randomUUID()}`, "parent-user", now);
      const foreignChild = await createSession(current, `tenant_${randomUUID()}`, "foreign-user", now);
      await current.store.commit({
        sessionId: foreignChild.id,
        fence: 1,
        lifecycle: {
          type: "tombstone",
          tenantId: foreignChild.tenantId,
          userId: foreignChild.userId,
          deletionGeneration: 1,
          atMs: now + 90,
        },
        events: [{
          type: "session/deleted",
          sessionId: foreignChild.id,
          deletionGeneration: 1,
          emittedAtMs: now + 90,
        }],
      });
      await current.conn.query(
        "UPDATE sessions SET parent_session_id=? WHERE session_id=?",
        [ownerParent.id, foreignChild.id],
      );
      await markLegacy(current, ownerParent, now + 100);

      const cycleA = await createSession(current, `tenant_${randomUUID()}`, "cycle-user", now);
      const cycleB = await createSession(current, cycleA.tenantId, cycleA.userId, now + 1, cycleA.id);
      await current.conn.query(
        "UPDATE sessions SET parent_session_id=? WHERE session_id=?",
        [cycleB.id, cycleA.id],
      );
      await markLegacy(current, cycleA, now + 100);
      await markLegacy(current, cycleB, now + 110);
      await activate(current.store, now + 150);

      const jobs = await current.store.scheduleLegacyTombstoneCandidates({
        cutoverGeneration: 1,
        actorKeyId: "legacy-maintenance",
        nowMs: now + 200,
        limit: 10,
      });
      const ownerJob = jobs.find((job) => job.sessionId === ownerParent.id)!;
      const cycleJobIds = new Set(jobs
        .filter((job) => job.sessionId === cycleA.id || job.sessionId === cycleB.id)
        .map((job) => job.jobId));
      expect(ownerJob).toBeDefined();
      expect(cycleJobIds.size).toBe(2);

      // Claim jobs deterministically by moving all but the desired locator out of the due set.
      await current.conn.query(
        "UPDATE legacy_tombstone_compensation_jobs SET available_at_ms=? WHERE job_id<>?",
        [now + 300, ownerJob.jobId],
      );
      const ownerClaim = await claimCompensation(current.store, now + 200, "owner-worker");
      const ownerAuthorization = compensationAuthorization(ownerClaim);
      expect(await current.store.completeLegacyTombstoneCompensation(
        ownerAuthorization,
        { completedAtMs: now + 201 },
      )).toMatchObject({
        outcome: "terminal_incident",
        reasonCode: "child_dependency_invalid",
      });
      expect(await current.store.completeLegacyTombstoneCompensation(
        ownerAuthorization,
        { completedAtMs: now + 202 },
      )).toBeNull();
      expect(await current.store.completeLegacyTombstoneCompensation(
        { ...ownerAuthorization, claimToken: "terminal-replay-token" },
        { completedAtMs: now + 202 },
      )).toBeNull();
      expect(await current.store.completeLegacyTombstoneCompensation(
        {
          ...ownerAuthorization,
          claimToken: "terminal-next-attempt",
          claimAttempt: ownerAuthorization.claimAttempt + 1,
        },
        { completedAtMs: now + 202 },
      )).toBeNull();

      const cycleJobId = [...cycleJobIds].sort()[0]!;
      await current.conn.query(
        "UPDATE legacy_tombstone_compensation_jobs SET available_at_ms=? WHERE job_id=?",
        [now + 202, cycleJobId],
      );
      const cycleClaim = await claimCompensation(current.store, now + 202, "cycle-worker");
      expect(await current.store.completeLegacyTombstoneCompensation(
        compensationAuthorization(cycleClaim),
        { completedAtMs: now + 203 },
      )).toMatchObject({
        outcome: "terminal_incident",
        reasonCode: "child_dependency_invalid",
      });
      const [unchanged] = await current.conn.query<Row[]>(
        `SELECT session_id, deletion_generation FROM sessions
          WHERE session_id IN (?, ?) ORDER BY session_id`,
        [ownerParent.id, cycleClaim.sessionId],
      );
      expect(unchanged.map((row) => Number(row.deletion_generation))).toEqual([0, 0]);
    });
  });
} else {
  describe("MysqlSessionStore legacy tombstone compensation", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
