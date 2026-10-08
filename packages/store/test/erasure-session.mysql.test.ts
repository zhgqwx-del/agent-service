import { randomUUID } from "node:crypto";
import { emptyUsage, type Approval, type Item, type Session, type Turn } from "@agent-service/protocol";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FenceError,
  MysqlSessionStore,
  SessionGoneError,
  SessionHasChildrenError,
  newErasureRequestId,
  userErasureRequestHash,
  type ErasureJobAuthorization,
  type ErasureJobClaim,
  type ErasureSessionAction,
  type ErasureWriteAuthorization,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
type Row = RowDataPacket;

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create erasure session fixture database from base database "${database}": `
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
  if (claim.subjectKind !== "user") throw new Error("test fixture requires a user erasure claim");
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    userId: claim.subjectId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

async function gateAndClaim(
  store: MysqlSessionStore,
  session: Session,
  targetStatus: "draining" | "tombstoning",
  tokenPrefix: string,
): Promise<{ authority: ErasureWriteAuthorization; claim: ErasureJobClaim; nowMs: number }> {
  const nowMs = Date.now();
  const requestId = newErasureRequestId();
  await store.requestUserErasure({
    requestId,
    tenantId: session.tenantId,
    userId: session.userId,
    requestedByKeyId: "admin-key",
    idempotencyKey: `erase-${randomUUID()}`,
    requestHash: userErasureRequestHash(session.tenantId, session.userId),
    atMs: nowMs,
  });

  const claimOne = (await store.claimErasureJobs({
    nowMs,
    limit: 100,
    leaseMs: 600_000,
    claimToken: `${tokenPrefix}-gated`,
  })).find((claim) => claim.requestId === requestId);
  if (!claimOne || claimOne.requestId !== requestId || claimOne.status !== "gated") {
    throw new Error("failed to claim the gated erasure fixture");
  }
  expect(await store.transitionErasureJob(jobAuthorization(claimOne), {
    fromStatus: "gated",
    toStatus: "draining",
    atMs: nowMs,
    availableAtMs: nowMs,
  })).toBe(true);

  const draining = (await store.claimErasureJobs({
    nowMs,
    limit: 100,
    leaseMs: 600_000,
    claimToken: `${tokenPrefix}-draining`,
  })).find((claim) => claim.requestId === requestId);
  if (!draining || draining.requestId !== requestId || draining.status !== "draining") {
    throw new Error("failed to claim the draining erasure fixture");
  }
  if (targetStatus === "draining") {
    return { authority: writeAuthorization(draining), claim: draining, nowMs };
  }

  expect(await store.transitionErasureJob(jobAuthorization(draining), {
    fromStatus: "draining",
    toStatus: "tombstoning",
    atMs: nowMs,
    availableAtMs: nowMs,
  })).toBe(true);
  const tombstoning = (await store.claimErasureJobs({
    nowMs,
    limit: 100,
    leaseMs: 600_000,
    claimToken: `${tokenPrefix}-tombstoning`,
  })).find((claim) => claim.requestId === requestId);
  if (!tombstoning || tombstoning.requestId !== requestId || tombstoning.status !== "tombstoning") {
    throw new Error("failed to claim the tombstoning erasure fixture");
  }
  return { authority: writeAuthorization(tombstoning), claim: tombstoning, nowMs };
}

function activeResources(session: Session, atMs = Date.now()): {
  turn: Turn;
  approval: Approval;
  item: Extract<Item, { type: "approvalRequest" }>;
} {
  const turn: Turn = {
    id: newId("turn"),
    sessionId: session.id,
    status: "inProgress",
    seqStart: 2,
    steps: 1,
    toolCalls: 1,
    usage: emptyUsage(),
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
    toolCallId: "call-danger",
    name: "danger",
    args: { secret: "fixture-content-must-not-enter-authority" },
  };
  const approval: Approval = {
    id: approvalId,
    sessionId: session.id,
    turnId: turn.id,
    // Deliberately does not match item.id. Historical rows used this field inconsistently; the
    // durable relation is approvalRequest.approvalId -> approval.id.
    itemId: newId("item"),
    status: "pending",
    toolCallId: item.toolCallId,
    toolName: item.name,
    args: item.args,
    availableDecisions: ["accept", "decline", "cancel"],
    createdAtMs: atMs,
    expiresAtMs: atMs + 60_000,
  };
  return { turn, approval, item };
}

async function seedActiveSession(
  store: MysqlSessionStore,
  session: Session,
  resources = activeResources(session),
): Promise<number> {
  const result = await store.commit({
    sessionId: session.id,
    fence: 1,
    turn: resources.turn,
    approvals: [resources.approval],
    items: [resources.item],
    events: [
      { type: "turn/started", sessionId: session.id, emittedAtMs: resources.turn.startedAtMs, turn: resources.turn },
      { type: "item/started", sessionId: session.id, emittedAtMs: resources.item.createdAtMs, item: resources.item },
      { type: "approval/requested", sessionId: session.id, emittedAtMs: resources.approval.createdAtMs, approval: resources.approval },
    ],
    sessionPatch: {
      status: { type: "active", turnId: resources.turn.id, activeFlags: ["waitingOnApproval"] },
      autoApprovedTools: ["must-be-cleared"],
    },
  });
  return result.lastSeq;
}

function decodeJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<
  { timedOut: false; value: T } | { timedOut: true }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const result = await Promise.race([
    promise.then((value) => ({ timedOut: false as const, value })),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore erasure session actions", () => {
    let admin: Connection | undefined;
    let mysqlUrl = "";
    let database = "";

    beforeAll(async () => {
      const base = assertDisposableTestTarget(BASE_MYSQL_URL);
      database = `agent_service_erasure_session_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_erasure_session_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe generated erasure session fixture database name");
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

    it("returns only the minimal head and fences atomically in the draining phase", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = {
        ...mkSession(`tenant_head_${randomUUID()}`, `user_${randomUUID()}`),
        title: "private title",
        metadata: { private: "metadata" },
      };
      try {
        await store.createSession(session);
        const { authority } = await gateAndClaim(store, session, "draining", "head");

        const head = await store.getErasureSessionHead(authority, session.id);
        expect(head).toEqual({
          sessionId: session.id,
          tenantId: session.tenantId,
          userId: session.userId,
          deleted: false,
          deletionGeneration: 0,
        });
        expect(Object.keys(head ?? {}).sort()).toEqual([
          "deleted", "deletionGeneration", "sessionId", "tenantId", "userId",
        ]);

        expect(await store.applyErasureSessionAction({
          authority,
          sessionId: session.id,
          fence: 7,
          action: "fence",
        })).toEqual({ events: [], lastSeq: 1 });
        const [rows] = await conn.query<(Row & { fence_token: number; last_seq: number })[]>(
          "SELECT fence_token, last_seq FROM sessions WHERE session_id=?",
          [session.id],
        );
        expect(rows[0]).toMatchObject({ fence_token: 7, last_seq: 1 });
        await expect(store.applyErasureSessionAction({
          authority,
          sessionId: session.id,
          fence: 6,
          action: "fence",
        })).rejects.toBeInstanceOf(FenceError);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("snapshots a mutable action before waiting for the session row lock", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const blocker = await mysql.createConnection(mysqlUrl);
      const first = mkSession(`tenant_mutable_action_${randomUUID()}`, `user_${randomUUID()}`);
      const second = mkSession(first.tenantId, first.userId);
      try {
        await store.createSession(first);
        await store.createSession(second);
        const { authority } = await gateAndClaim(store, first, "draining", "mutable-action");
        const action: ErasureSessionAction = {
          authority: { ...authority },
          sessionId: first.id,
          fence: 7,
          action: "fence",
        };

        await blocker.beginTransaction();
        await blocker.query("SELECT session_id FROM sessions WHERE session_id=? FOR UPDATE", [first.id]);
        const pending = store.applyErasureSessionAction(action);
        action.sessionId = second.id;
        action.fence = 99;

        const blocked = await settleWithin(pending, 100);
        expect(blocked).toEqual({ timedOut: true });
        await blocker.rollback();
        await expect(pending).resolves.toEqual({ events: [], lastSeq: 1 });

        const [rows] = await blocker.query<(Row & { session_id: string; fence_token: number })[]>(
          "SELECT session_id, fence_token FROM sessions WHERE session_id IN (?,?) ORDER BY session_id",
          [first.id, second.id],
        );
        expect(rows.find((row) => row.session_id === first.id)?.fence_token).toBe(7);
        expect(rows.find((row) => row.session_id === second.id)?.fence_token).toBe(0);
      } finally {
        await blocker.rollback().catch(() => {});
        await blocker.end();
        await store.close();
      }
    });

    it("does not lock a different owner's session while returning hidden-resource semantics", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const blocker = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_owner_scope_${randomUUID()}`;
      const owner = mkSession(tenantId, `user_owner_${randomUUID()}`);
      const hidden = mkSession(tenantId, `user_hidden_${randomUUID()}`);
      try {
        await store.createSession(owner);
        await store.createSession(hidden);
        const { authority } = await gateAndClaim(store, owner, "draining", "owner-scope");

        await blocker.beginTransaction();
        await blocker.query("SELECT session_id FROM sessions WHERE session_id=? FOR UPDATE", [hidden.id]);
        const headPromise = store.getErasureSessionHead(authority, hidden.id);
        const headOutcome = await settleWithin(headPromise);
        await blocker.rollback();
        if (headOutcome.timedOut) {
          await headPromise;
          throw new Error("cross-owner erasure head read waited on the hidden session row");
        }
        expect(headOutcome.value).toBeNull();

        await blocker.beginTransaction();
        await blocker.query("SELECT session_id FROM sessions WHERE session_id=? FOR UPDATE", [hidden.id]);
        const actionPromise = store.applyErasureSessionAction({
          authority,
          sessionId: hidden.id,
          fence: 7,
          action: "fence",
        }).then(
          (value) => ({ kind: "resolved" as const, value }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        const actionOutcome = await settleWithin(actionPromise);
        await blocker.rollback();
        if (actionOutcome.timedOut) {
          await actionPromise;
          throw new Error("cross-owner erasure action waited on the hidden session row");
        }
        expect(actionOutcome.value.kind).toBe("rejected");
        if (actionOutcome.value.kind === "rejected") {
          expect(actionOutcome.value.error).toBeInstanceOf(SessionGoneError);
        }

        const [rows] = await blocker.query<(Row & { fence_token: number; last_seq: number })[]>(
          "SELECT fence_token, last_seq FROM sessions WHERE session_id=?",
          [hidden.id],
        );
        expect(rows[0]).toMatchObject({ fence_token: 0, last_seq: 1 });
      } finally {
        await blocker.rollback().catch(() => {});
        await blocker.end();
        await store.close();
      }
    });

    it("settles an active turn and historical approval association with contiguous events", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(`tenant_settle_${randomUUID()}`, `user_${randomUUID()}`);
      const resources = activeResources(session);
      try {
        await store.createSession(session);
        const beforeSeq = await seedActiveSession(store, session, resources);
        const { authority, nowMs } = await gateAndClaim(store, session, "tombstoning", "settle");
        const head = await store.getErasureSessionHead(authority, session.id);
        expect(head).toEqual({
          sessionId: session.id,
          tenantId: session.tenantId,
          userId: session.userId,
          activeTurnId: resources.turn.id,
          deleted: false,
          deletionGeneration: 0,
        });

        const result = await store.applyErasureSessionAction({
          authority,
          sessionId: session.id,
          fence: 9,
          action: "settle",
          atMs: nowMs + 10,
        });
        expect(result.events.map((event) => event.type)).toEqual([
          "approval/resolved",
          "item/completed",
          "turn/completed",
          "session/status/changed",
        ]);
        expect(result.events.map((event) => event.seq)).toEqual([
          beforeSeq + 1, beforeSeq + 2, beforeSeq + 3, beforeSeq + 4,
        ]);

        const [sessionRows] = await conn.query<(Row & {
          status: string; last_seq: number; fence_token: number; auto_approved_tools: string;
        })[]>(
          "SELECT status, last_seq, fence_token, auto_approved_tools FROM sessions WHERE session_id=?",
          [session.id],
        );
        expect(decodeJson<{ type: string }>(sessionRows[0]!.status)).toEqual({ type: "idle" });
        expect(sessionRows[0]).toMatchObject({ last_seq: beforeSeq + 4, fence_token: 9 });
        expect(decodeJson<unknown[]>(sessionRows[0]!.auto_approved_tools)).toEqual(["must-be-cleared"]);

        const [turnRows] = await conn.query<(Row & { status: string; seq_end: number; body: string })[]>(
          "SELECT status, seq_end, body FROM turns WHERE turn_id=?",
          [resources.turn.id],
        );
        expect(turnRows[0]).toMatchObject({ status: "interrupted", seq_end: beforeSeq + 4 });
        expect(decodeJson<Turn>(turnRows[0]!.body)).toMatchObject({
          status: "interrupted",
          stopReason: "interrupted",
          seqEnd: beforeSeq + 4,
          error: { code: "erasure" },
        });
        const [approvalRows] = await conn.query<(Row & { status: string; body: string })[]>(
          "SELECT status, body FROM approvals WHERE approval_id=?",
          [resources.approval.id],
        );
        expect(approvalRows[0]?.status).toBe("expired");
        expect(decodeJson<Approval>(approvalRows[0]!.body)).toMatchObject({
          id: resources.approval.id,
          itemId: resources.approval.itemId,
          decision: "cancel",
          decidedBy: "system:erasure",
        });
        const [itemRows] = await conn.query<(Row & { status: string; body: string })[]>(
          "SELECT status, body FROM items WHERE item_id=?",
          [resources.item.id],
        );
        expect(itemRows[0]?.status).toBe("declined");
        expect(decodeJson<Item>(itemRows[0]!.body)).toMatchObject({
          id: resources.item.id,
          approvalId: resources.approval.id,
          status: "declined",
        });
        const [eventRows] = await conn.query<(Row & { seq: number; type: string })[]>(
          "SELECT seq, type FROM events WHERE session_id=? AND seq>? ORDER BY seq",
          [session.id, beforeSeq],
        );
        expect(eventRows.map(({ seq, type }) => ({ seq, type }))).toEqual(result.events.map(({ seq, type }) => ({ seq, type })));
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("makes idle settlement a no-op and concurrent tombstone retries create one event and two intents", async () => {
      const firstStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const secondStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(`tenant_tombstone_${randomUUID()}`, `user_${randomUUID()}`);
      try {
        await firstStore.createSession(session);
        const { authority, nowMs } = await gateAndClaim(firstStore, session, "tombstoning", "tombstone");
        expect(await firstStore.applyErasureSessionAction({
          authority,
          sessionId: session.id,
          fence: 3,
          action: "settle",
          atMs: nowMs + 1,
        })).toEqual({ events: [], lastSeq: 1 });

        const actions = await Promise.all([
          firstStore.applyErasureSessionAction({
            authority,
            sessionId: session.id,
            fence: 4,
            action: "tombstone",
            atMs: nowMs + 2,
          }),
          secondStore.applyErasureSessionAction({
            authority,
            sessionId: session.id,
            fence: 4,
            action: "tombstone",
            atMs: nowMs + 2,
          }),
        ]);
        expect(actions.flatMap((result) => result.events).map((event) => event.type)).toEqual(["session/deleted"]);
        expect(actions.map((result) => result.lifecycleGeneration)).toEqual([1, 1]);

        expect(await firstStore.applyErasureSessionAction({
          authority,
          sessionId: session.id,
          fence: 4,
          action: "tombstone",
          atMs: nowMs + 3,
        })).toEqual({ events: [], lastSeq: 2, lifecycleGeneration: 1 });
        expect(await firstStore.getErasureSessionHead(authority, session.id)).toEqual({
          sessionId: session.id,
          tenantId: session.tenantId,
          userId: session.userId,
          deleted: true,
          deletionGeneration: 1,
        });

        const tombstoned = await firstStore.getLifecycleOutbox("session.tombstoned", session.id, 1);
        expect(tombstoned).toMatchObject({
          topic: "session.tombstoned",
          aggregateId: session.id,
          generation: 1,
          availableAtMs: nowMs + 2,
          payload: { sessionId: session.id, deletionGeneration: 1, eventSeq: 2 },
        });
        const purge = await firstStore.getLifecycleOutbox("session.purge", session.id, 1);
        expect(purge).toMatchObject({
          topic: "session.purge",
          aggregateId: session.id,
          generation: 1,
          payload: { sessionId: session.id, deletionGeneration: 1 },
        });
        expect(purge?.availableAtMs).toBeUndefined();

        const [counts] = await conn.query<(Row & { events: number; outbox: number })[]>(
          `SELECT
             (SELECT COUNT(*) FROM events WHERE session_id=? AND type='session/deleted') AS events,
             (SELECT COUNT(*) FROM lifecycle_outbox WHERE aggregate_id=?) AS outbox`,
          [session.id, session.id],
        );
        expect({ events: Number(counts[0]?.events), outbox: Number(counts[0]?.outbox) })
          .toEqual({ events: 1, outbox: 2 });
      } finally {
        await conn.end();
        await secondStore.close();
        await firstStore.close();
      }
    });

    it.each([
      {
        name: "positive deletion generation",
        corrupt: (conn: Connection, session: Session, _atMs: number) => conn.query(
          "UPDATE sessions SET deletion_generation=7 WHERE session_id=?",
          [session.id],
        ),
        expectedGeneration: 7,
        expectedPurgeAfterMs: null,
      },
      {
        name: "scheduled purge",
        corrupt: (conn: Connection, session: Session, atMs: number) => conn.query(
          "UPDATE sessions SET purge_after_ms=? WHERE session_id=?",
          [atMs, session.id],
        ),
        expectedGeneration: 0,
        expectedPurgeAfterMs: "atMs" as const,
      },
    ])("fails a live session tombstone closed for corrupt $name without partial writes", async ({
      corrupt,
      expectedGeneration,
      expectedPurgeAfterMs,
    }) => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(`tenant_live_marker_${randomUUID()}`, `user_${randomUUID()}`);
      try {
        await store.createSession(session);
        const { authority, nowMs } = await gateAndClaim(
          store,
          session,
          "tombstoning",
          `live-marker-${randomUUID()}`,
        );
        const corruptPurgeAfterMs = nowMs + 60_000;
        await corrupt(conn, session, corruptPurgeAfterMs);

        await expect(store.applyErasureSessionAction({
          authority,
          sessionId: session.id,
          fence: 8,
          action: "tombstone",
          atMs: nowMs + 1,
        })).rejects.toThrow("stored live session tombstone marker is corrupt");

        const [sessionRows] = await conn.query<(Row & {
          deleted_at_ms: number | null;
          purge_after_ms: number | null;
          deletion_generation: number;
          last_seq: number;
          fence_token: number;
        })[]>(
          `SELECT deleted_at_ms, purge_after_ms, deletion_generation, last_seq, fence_token
             FROM sessions WHERE session_id=?`,
          [session.id],
        );
        expect(sessionRows[0]).toMatchObject({
          deleted_at_ms: null,
          purge_after_ms: expectedPurgeAfterMs === "atMs" ? corruptPurgeAfterMs : null,
          deletion_generation: expectedGeneration,
          last_seq: 1,
          fence_token: 0,
        });
        const [counts] = await conn.query<(Row & { events: number; outbox: number })[]>(
          `SELECT
             (SELECT COUNT(*) FROM events WHERE session_id=? AND type='session/deleted') AS events,
             (SELECT COUNT(*) FROM lifecycle_outbox WHERE aggregate_id=?) AS outbox`,
          [session.id, session.id],
        );
        expect({ events: Number(counts[0]?.events), outbox: Number(counts[0]?.outbox) })
          .toEqual({ events: 0, outbox: 0 });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it.each([
      {
        name: "zero deletion generation",
        corrupt: (conn: Connection, session: Session) => conn.query(
          "UPDATE sessions SET deletion_generation=0 WHERE session_id=?",
          [session.id],
        ),
      },
      {
        name: "terminal event generation",
        corrupt: (conn: Connection, session: Session) => conn.query(
          `UPDATE events SET body=JSON_SET(body, '$.deletionGeneration', 2)
            WHERE session_id=? AND type='session/deleted'`,
          [session.id],
        ),
      },
      {
        name: "session.tombstoned identity",
        corrupt: (conn: Connection, session: Session) => conn.query(
          `UPDATE lifecycle_outbox SET aggregate_id=?
            WHERE topic='session.tombstoned' AND aggregate_id=? AND generation=1`,
          [newId("sess"), session.id],
        ),
      },
      {
        name: "session.tombstoned event sequence",
        corrupt: (conn: Connection, session: Session) => conn.query(
          `UPDATE lifecycle_outbox SET payload=JSON_SET(payload, '$.eventSeq', 999999)
            WHERE topic='session.tombstoned' AND aggregate_id=? AND generation=1`,
          [session.id],
        ),
      },
      {
        name: "session.purge payload generation",
        corrupt: (conn: Connection, session: Session) => conn.query(
          `UPDATE lifecycle_outbox SET payload=JSON_SET(payload, '$.deletionGeneration', 2)
            WHERE topic='session.purge' AND aggregate_id=? AND generation=1`,
          [session.id],
        ),
      },
      {
        name: "claimable session.purge intent",
        corrupt: (conn: Connection, session: Session) => conn.query(
          `UPDATE lifecycle_outbox SET available_at_ms=1
            WHERE topic='session.purge' AND aggregate_id=? AND generation=1`,
          [session.id],
        ),
      },
    ])("fails a tombstone retry closed for corrupt $name", async ({ name, corrupt }) => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(`tenant_retry_integrity_${randomUUID()}`, `user_${randomUUID()}`);
      try {
        await store.createSession(session);
        const { authority, nowMs } = await gateAndClaim(store, session, "tombstoning", `integrity-${randomUUID()}`);
        expect(await store.applyErasureSessionAction({
          authority,
          sessionId: session.id,
          fence: 6,
          action: "tombstone",
          atMs: nowMs + 1,
        })).toMatchObject({ lastSeq: 2, lifecycleGeneration: 1 });

        expect(await store.applyErasureSessionAction({
          authority,
          sessionId: session.id,
          fence: 6,
          action: "tombstone",
          atMs: nowMs + 2,
        })).toEqual({ events: [], lastSeq: 2, lifecycleGeneration: 1 });

        await corrupt(conn, session);
        await expect(store.applyErasureSessionAction({
          authority,
          sessionId: session.id,
          fence: 6,
          action: "tombstone",
          atMs: nowMs + 3,
        })).rejects.toThrow();
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls a parent tombstone back while any direct child is live", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const parent = mkSession(`tenant_parent_${randomUUID()}`, `user_${randomUUID()}`);
      const child = { ...mkSession(parent.tenantId, parent.userId), parentSessionId: parent.id };
      try {
        await store.createSession(parent);
        await store.createSession(child);
        const { authority, nowMs } = await gateAndClaim(store, parent, "tombstoning", "parent");
        await expect(store.applyErasureSessionAction({
          authority,
          sessionId: parent.id,
          fence: 5,
          action: "tombstone",
          atMs: nowMs + 1,
        })).rejects.toBeInstanceOf(SessionHasChildrenError);

        const [sessions] = await conn.query<(Row & {
          session_id: string; deleted_at_ms: number | null; last_seq: number; fence_token: number;
        })[]>(
          "SELECT session_id, deleted_at_ms, last_seq, fence_token FROM sessions WHERE session_id IN (?,?) ORDER BY session_id",
          [parent.id, child.id],
        );
        expect(sessions).toHaveLength(2);
        expect(sessions.every((row) => row.deleted_at_ms === null && row.last_seq === 1 && row.fence_token === 0)).toBe(true);
        const [outbox] = await conn.query<(Row & { count: number })[]>(
          "SELECT COUNT(*) AS count FROM lifecycle_outbox WHERE aggregate_id=?",
          [parent.id],
        );
        expect(Number(outbox[0]?.count)).toBe(0);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rejects stale phase and every stale authority dimension without writing", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const phaseSession = mkSession(`tenant_phase_${randomUUID()}`, `user_${randomUUID()}`);
      const staleSession = mkSession(`tenant_stale_${randomUUID()}`, `user_${randomUUID()}`);
      try {
        await store.createSession(phaseSession);
        const draining = await gateAndClaim(store, phaseSession, "draining", "phase");
        await expect(store.applyErasureSessionAction({
          authority: draining.authority,
          sessionId: phaseSession.id,
          fence: 2,
          action: "settle",
          atMs: draining.nowMs + 1,
        })).rejects.toThrow("stale erasure authority");

        await store.createSession(staleSession);
        const current = await gateAndClaim(store, staleSession, "tombstoning", "stale");
        const variants: ErasureWriteAuthorization[] = [
          { ...current.authority, claimToken: "wrong-token" },
          { ...current.authority, claimAttempt: current.authority.claimAttempt + 1 },
          { ...current.authority, tenantId: `tenant_other_${randomUUID()}` },
          { ...current.authority, userId: `user_${randomUUID()}` },
          { ...current.authority, subjectGeneration: current.authority.subjectGeneration + 1 },
        ];
        for (const authority of variants) {
          await expect(store.applyErasureSessionAction({
            authority,
            sessionId: staleSession.id,
            fence: 8,
            action: "fence",
          })).rejects.toThrow();
        }

        await conn.query(
          "UPDATE erasure_requests SET lease_until_ms=? WHERE request_id=?",
          [Date.now() - 1, current.authority.requestId],
        );
        await expect(store.applyErasureSessionAction({
          authority: current.authority,
          sessionId: staleSession.id,
          fence: 8,
          action: "fence",
        })).rejects.toThrow("stale erasure authority");

        const [rows] = await conn.query<(Row & { session_id: string; last_seq: number; fence_token: number })[]>(
          "SELECT session_id, last_seq, fence_token FROM sessions WHERE session_id IN (?,?) ORDER BY session_id",
          [phaseSession.id, staleSession.id],
        );
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.last_seq === 1 && row.fence_token === 0)).toBe(true);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls back when an active projection has a missing or terminal turn", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const missing = mkSession(`tenant_missing_${randomUUID()}`, `user_${randomUUID()}`);
      const terminal = mkSession(`tenant_terminal_${randomUUID()}`, `user_${randomUUID()}`);
      try {
        await store.createSession(missing);
        const missingTurnId = newId("turn");
        await store.commit({
          sessionId: missing.id,
          fence: 1,
          sessionPatch: { status: { type: "active", turnId: missingTurnId, activeFlags: [] } },
        });
        const missingClaim = await gateAndClaim(store, missing, "tombstoning", "missing");
        await expect(store.applyErasureSessionAction({
          authority: missingClaim.authority,
          sessionId: missing.id,
          fence: 9,
          action: "settle",
          atMs: missingClaim.nowMs + 1,
        })).rejects.toThrow("active erasure turn is missing");

        await store.createSession(terminal);
        const resources = activeResources(terminal);
        const terminalBeforeSeq = await seedActiveSession(store, terminal, resources);
        const completed: Turn = {
          ...resources.turn,
          status: "completed",
          stopReason: "end_turn",
          seqEnd: terminalBeforeSeq,
          completedAtMs: Date.now(),
        };
        await conn.query(
          "UPDATE turns SET status='completed', stop_reason='end_turn', seq_end=?, body=?, completed_at_ms=? WHERE turn_id=?",
          [terminalBeforeSeq, JSON.stringify(completed), completed.completedAtMs, resources.turn.id],
        );
        const terminalClaim = await gateAndClaim(store, terminal, "tombstoning", "terminal");
        await expect(store.applyErasureSessionAction({
          authority: terminalClaim.authority,
          sessionId: terminal.id,
          fence: 9,
          action: "settle",
          atMs: terminalClaim.nowMs + 1,
        })).rejects.toThrow("active erasure turn identity is corrupt");

        const [rows] = await conn.query<(Row & { session_id: string; last_seq: number; fence_token: number; status: string })[]>(
          "SELECT session_id, last_seq, fence_token, status FROM sessions WHERE session_id IN (?,?) ORDER BY session_id",
          [missing.id, terminal.id],
        );
        const missingRow = rows.find((row) => row.session_id === missing.id)!;
        const terminalRow = rows.find((row) => row.session_id === terminal.id)!;
        expect(missingRow).toMatchObject({ last_seq: 1, fence_token: 1 });
        expect(terminalRow).toMatchObject({ last_seq: terminalBeforeSeq, fence_token: 1 });
        expect(decodeJson<{ type: string }>(missingRow.status).type).toBe("active");
        expect(decodeJson<{ type: string }>(terminalRow.status).type).toBe("active");
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls back resource settlement, events, cursor and fence when the final session write fails", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(`tenant_rollback_${randomUUID()}`, `user_${randomUUID()}`);
      const resources = activeResources(session);
      const triggerName = `fail_erasure_settle_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      try {
        await store.createSession(session);
        const beforeSeq = await seedActiveSession(store, session, resources);
        const { authority, nowMs } = await gateAndClaim(store, session, "tombstoning", "rollback");
        await conn.query(
          `CREATE TRIGGER \`${triggerName}\` BEFORE UPDATE ON sessions FOR EACH ROW
           BEGIN
             IF NEW.session_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(NEW.status, '$.type')) = 'idle' THEN
               SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected erasure settlement failure';
             END IF;
           END`,
          [session.id],
        );

        await expect(store.applyErasureSessionAction({
          authority,
          sessionId: session.id,
          fence: 11,
          action: "settle",
          atMs: nowMs + 1,
        })).rejects.toThrow("injected erasure settlement failure");

        const [sessionRows] = await conn.query<(Row & { last_seq: number; fence_token: number; status: string })[]>(
          "SELECT last_seq, fence_token, status FROM sessions WHERE session_id=?",
          [session.id],
        );
        expect(sessionRows[0]).toMatchObject({ last_seq: beforeSeq, fence_token: 1 });
        expect(decodeJson<{ type: string }>(sessionRows[0]!.status).type).toBe("active");
        const [turnRows] = await conn.query<(Row & { status: string })[]>(
          "SELECT status FROM turns WHERE turn_id=?",
          [resources.turn.id],
        );
        const [approvalRows] = await conn.query<(Row & { status: string })[]>(
          "SELECT status FROM approvals WHERE approval_id=?",
          [resources.approval.id],
        );
        const [itemRows] = await conn.query<(Row & { status: string })[]>(
          "SELECT status FROM items WHERE item_id=?",
          [resources.item.id],
        );
        const [eventRows] = await conn.query<(Row & { count: number })[]>(
          "SELECT COUNT(*) AS count FROM events WHERE session_id=?",
          [session.id],
        );
        expect(turnRows[0]?.status).toBe("inProgress");
        expect(approvalRows[0]?.status).toBe("pending");
        expect(itemRows[0]?.status).toBe("inProgress");
        expect(Number(eventRows[0]?.count)).toBe(beforeSeq);

        await conn.query(`DROP TRIGGER \`${triggerName}\``);
        expect((await store.applyErasureSessionAction({
          authority,
          sessionId: session.id,
          fence: 11,
          action: "settle",
          atMs: nowMs + 2,
        })).events.map((event) => event.type)).toEqual([
          "approval/resolved", "item/completed", "turn/completed", "session/status/changed",
        ]);
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("rejects a reused-token ABA claim while the replacement attempt can fence", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const session = mkSession(`tenant_aba_${randomUUID()}`, `user_${randomUUID()}`);
      try {
        await store.createSession(session);
        const first = await gateAndClaim(store, session, "tombstoning", "aba");
        const takeoverAtMs = Date.now() + 100;
        await conn.query(
          "UPDATE erasure_requests SET claim_token=?, lease_until_ms=? WHERE request_id=?",
          ["reused-token", takeoverAtMs, first.claim.requestId],
        );
        const stale = { ...first.authority, claimToken: "reused-token" };
        const replacement = (await store.claimErasureJobs({
          nowMs: takeoverAtMs,
          limit: 100,
          leaseMs: 600_000,
          claimToken: "reused-token",
        })).find((claim) => claim.requestId === first.claim.requestId);
        if (!replacement || replacement.requestId !== first.claim.requestId) {
          throw new Error("failed to take over the ABA fixture claim");
        }
        expect(replacement.attempts).toBe(first.claim.attempts + 1);

        await expect(store.applyErasureSessionAction({
          authority: stale,
          sessionId: session.id,
          fence: 12,
          action: "fence",
        })).rejects.toThrow("stale erasure authority");
        expect(await store.applyErasureSessionAction({
          authority: writeAuthorization(replacement),
          sessionId: session.id,
          fence: 12,
          action: "fence",
        })).toEqual({ events: [], lastSeq: 1 });

        const [rows] = await conn.query<(Row & { fence_token: number; last_seq: number })[]>(
          "SELECT fence_token, last_seq FROM sessions WHERE session_id=?",
          [session.id],
        );
        expect(rows[0]).toMatchObject({ fence_token: 12, last_seq: 1 });
      } finally {
        await conn.end();
        await store.close();
      }
    });
  });
} else {
  describe("MysqlSessionStore erasure session actions", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
