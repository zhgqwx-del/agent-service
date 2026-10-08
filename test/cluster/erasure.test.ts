import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  openSse,
  queryDb,
  startCluster,
  waitFor,
  type Cluster,
  type Proc,
} from "./harness.js";

const enabled = !!process.env.AGENT_SERVICE_CLUSTER;
let cluster: Cluster | undefined;

afterEach(async () => {
  await cluster?.stop();
  cluster = undefined;
});

interface SessionRef {
  id: string;
}

interface ErasureResponse {
  id: string;
  status: string;
}

interface ErasureRow {
  status: string;
  attempts: number;
  claimed: number;
  available_at_ms: number | null;
  lease_until_ms: number | null;
}

const workerClusterOptions = {
  runners: 2,
  dataErasureRequestsEnabled: true,
  leaseTtlMs: 2_000,
  leaseHoldMs: 100,
  erasureWorkerPollMs: 500,
  erasureWorkerLeaseMs: 2_000,
  erasureWorkerRetryBaseMs: 100,
  erasureWorkerRetryMaxMs: 500,
  erasureWorkerRequestTimeoutMs: 2_000,
  // runner-1 is the deterministic job worker. runner-2 still advertises and serves drain-v1, but
  // its next poll is outside the test window so an active turn there must be reached through router.
  runnerEnv: (runnerNumber: number) => ({
    ERASURE_WORKER_POLL_MS: runnerNumber === 1 ? "500" : "300000",
  }),
} as const;

async function createAgent(base: string): Promise<string> {
  const response = await api<{ id: string }>(base, "/v1/agents", {
    method: "POST",
    body: JSON.stringify({
      name: "erasure-cluster",
      instructions: "be brief",
      model: { provider: "deepseek", model: "deepseek-chat" },
      tools: [],
      limits: { maxSteps: 4 },
    }),
  });
  expect(response.status).toBe(201);
  return response.body.id;
}

async function createSession(
  base: string,
  agentId: string,
  parentSessionId?: string,
): Promise<SessionRef> {
  const response = await api<SessionRef>(base, "/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      agentId,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
    }),
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function requestUserErasure(base: string, idempotencyKey: string): Promise<ErasureResponse> {
  const response = await api<ErasureResponse>(base, "/v1/data-erasure-requests", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
  });
  expect(response.status).toBe(202);
  expect(response.body.status).toBe("gated");
  return response.body;
}

async function waitForErasureRow(
  requestId: string,
  predicate: (row: ErasureRow) => boolean,
  label: string,
  timeoutMs = 45_000,
): Promise<ErasureRow> {
  return waitFor(async () => {
    const [row] = await queryDb<ErasureRow>(
      `SELECT status, attempts, claim_token IS NOT NULL AS claimed,
              available_at_ms, lease_until_ms
         FROM erasure_requests WHERE request_id=?`,
      [requestId],
    );
    return row && predicate(row) ? row : undefined;
  }, timeoutMs, label);
}

async function expectSequentialEvents(sessionIds: string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    const rows = await queryDb<{ seq: number }>(
      "SELECT seq FROM events WHERE session_id=? ORDER BY seq",
      [sessionId],
    );
    const seqs = rows.map((row) => Number(row.seq));
    expect(seqs.length).toBeGreaterThan(1);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
  }
}

async function expectFinalNonPurgeState(
  requestId: string,
  sessions: SessionRef[],
  statusBase: string,
): Promise<void> {
  const final = await waitForErasureRow(
    requestId,
    (row) => row.status === "awaiting_purge_policy",
    "erasure reaches awaiting_purge_policy",
  );
  expect(Number(final.claimed)).toBe(0);
  expect(final.available_at_ms).toBeNull();
  expect(final.lease_until_ms).toBeNull();

  const status = await api<ErasureResponse>(
    statusBase,
    `/v1/data-erasure-requests/${requestId}`,
  );
  expect(status.status).toBe(200);
  expect(status.body).toMatchObject({ id: requestId, status: "awaiting_purge_policy" });

  const ids = sessions.map((session) => session.id);
  const placeholders = ids.map(() => "?").join(",");
  const sessionRows = await queryDb<{
    session_id: string;
    deleted_at_ms: number | null;
    purge_after_ms: number | null;
    deletion_generation: number;
  }>(
    `SELECT session_id, deleted_at_ms, purge_after_ms, deletion_generation
       FROM sessions WHERE session_id IN (${placeholders}) ORDER BY session_id`,
    ids,
  );
  expect(sessionRows).toHaveLength(ids.length);
  expect(sessionRows.every((row) => (
    row.deleted_at_ms !== null
    && row.purge_after_ms === null
    && Number(row.deletion_generation) === 1
  ))).toBe(true);

  const purgeRows = await queryDb<{
    aggregate_id: string;
    available_at_ms: number | null;
    completed_at_ms: number | null;
    dead_lettered_at_ms: number | null;
  }>(
    `SELECT aggregate_id, available_at_ms, completed_at_ms, dead_lettered_at_ms
       FROM lifecycle_outbox
      WHERE topic='session.purge' AND aggregate_id IN (${placeholders})`,
    ids,
  );
  expect(purgeRows).toHaveLength(ids.length);
  expect(purgeRows.every((row) => (
    row.available_at_ms === null
    && row.completed_at_ms === null
    && row.dead_lettered_at_ms === null
  ))).toBe(true);

  const terminalEvents = await queryDb<{ session_id: string; total: number }>(
    `SELECT session_id, COUNT(*) total
       FROM events
      WHERE type='session/deleted' AND session_id IN (${placeholders})
      GROUP BY session_id`,
    ids,
  );
  expect(terminalEvents).toHaveLength(ids.length);
  expect(terminalEvents.every((row) => Number(row.total) === 1)).toBe(true);
  await expectSequentialEvents(ids);

  for (const session of sessions) {
    expect((await api(statusBase, `/v1/sessions/${session.id}`)).status).toBe(404);
  }
}

function assertOwner(clusterValue: Cluster, sessionId: string, expected: Proc) {
  return waitFor(async () => {
    const owner = await clusterValue.redis.hget(`as:lease:{${sessionId}}`, "addr");
    return owner === expected.url.replace("http://", "") ? owner : undefined;
  }, 5_000, "expected session owner");
}

describe.skipIf(!enabled)("cluster: durable user erasure worker", () => {
  beforeAll(() => {
    expect(process.env.AGENT_SERVICE_CLUSTER).toBeTruthy();
  });

  it("drains a remote active owner, tombstones child-first, reconciles usage and stops before purge", async () => {
    cluster = await startCluster({
      ...workerClusterOptions,
      script: [
        { text: "child usage", ttftMs: 20 },
        { text: "slow parent turn", ttftMs: 8_000 },
      ],
    });
    const [workerRunner, ownerRunner] = cluster.runners;
    const agentId = await createAgent(cluster.router.url);
    const parent = await createSession(cluster.router.url, agentId);
    const child = await createSession(cluster.router.url, agentId, parent.id);

    const childTurn = await api<{ turn: { id: string } }>(
      workerRunner!.url,
      `/v1/sessions/${child.id}/turns`,
      {
        method: "POST",
        body: JSON.stringify({
          input: [{ type: "text", text: "record usage before erasure" }],
          stream: false,
        }),
      },
    );
    expect(childTurn.status).toBe(202);
    await waitFor(async () => {
      const [row] = await queryDb<{ status: string }>(
        "SELECT status FROM turns WHERE turn_id=?",
        [childTurn.body.turn.id],
      );
      return row?.status === "completed" ? row : undefined;
    }, 15_000, "child usage turn completes");

    const slow = openSse(ownerRunner!.url, `/v1/sessions/${parent.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "keep the parent active" }] }),
    });
    const started = await waitFor(
      () => slow.events.find((event) => event.event === "turn/started"),
      15_000,
      "parent slow turn starts",
    );
    const slowTurnId = (started.data.turn as { id: string }).id;
    await assertOwner(cluster, parent.id, ownerRunner!);

    const request = await requestUserErasure(cluster.router.url, "cluster-erasure-remote-owner");
    await expectFinalNonPurgeState(
      request.id,
      [parent, child],
      cluster.router.url,
    );
    slow.cancel();

    // runner-2 cannot poll again during this test, yet its active turn was interrupted while the
    // process stayed alive. Therefore runner-1's worker reached the owner through the private router.
    expect(ownerRunner!.child.exitCode).toBeNull();
    const [turn] = await queryDb<{ status: string; stop_reason: string | null }>(
      "SELECT status, stop_reason FROM turns WHERE turn_id=?",
      [slowTurnId],
    );
    expect(turn).toMatchObject({ status: "interrupted", stop_reason: "interrupted" });

    const reconciliations = await queryDb<{
      session_id: string;
      status: string;
      row_count: number;
    }>(
      `SELECT session_id, status, row_count
         FROM usage_reconciliations
        WHERE session_id IN (?,?) ORDER BY session_id`,
      [parent.id, child.id],
    );
    expect(reconciliations).toHaveLength(2);
    expect(reconciliations.every((row) => row.status === "verified")).toBe(true);
    expect(Number(reconciliations.find((row) => row.session_id === child.id)?.row_count)).toBeGreaterThan(0);

    // Reconciliation copied the durable billing fact but deliberately retained operational usage:
    // anonymization and physical purge are later policy-gated phases.
    const [usage] = await queryDb<{ total: number }>(
      "SELECT COUNT(*) total FROM usage_ledger WHERE session_id=?",
      [child.id],
    );
    expect(Number(usage?.total)).toBeGreaterThan(0);
    const [billing] = await queryDb<{ total: number }>(
      "SELECT COUNT(*) total FROM billing_usage_facts WHERE tenant_id='t_cluster'",
    );
    expect(Number(billing?.total)).toBeGreaterThan(0);

    const order = await queryDb<{ aggregate_id: string; first_outbox_id: number }>(
      `SELECT aggregate_id, MIN(outbox_id) first_outbox_id
         FROM lifecycle_outbox
        WHERE topic='session.tombstoned' AND aggregate_id IN (?,?)
        GROUP BY aggregate_id`,
      [parent.id, child.id],
    );
    const childOrder = Number(order.find((row) => row.aggregate_id === child.id)?.first_outbox_id);
    const parentOrder = Number(order.find((row) => row.aggregate_id === parent.id)?.first_outbox_id);
    expect(childOrder).toBeLessThan(parentOrder);

    const [content] = await queryDb<{ turns: number; items: number; events: number }>(
      `SELECT
        (SELECT COUNT(*) FROM turns WHERE session_id IN (?,?)) turns,
        (SELECT COUNT(*) FROM items WHERE session_id IN (?,?)) items,
        (SELECT COUNT(*) FROM events WHERE session_id IN (?,?)) events`,
      [parent.id, child.id, parent.id, child.id, parent.id, child.id],
    );
    expect(Number(content?.turns)).toBeGreaterThanOrEqual(2);
    expect(Number(content?.items)).toBeGreaterThan(0);
    expect(Number(content?.events)).toBeGreaterThan(2);
  }, 120_000);

  it("recovers after the active owner is SIGKILLed with a live drain claim", async () => {
    cluster = await startCluster({
      ...workerClusterOptions,
      // Leave ample room on slower CI hosts to observe at least one bounded retry before expiry.
      leaseTtlMs: 4_000,
      script: [{ text: "too late from crashed owner", ttftMs: 8_000 }],
    });
    const [workerRunner, ownerRunner] = cluster.runners;
    const agentId = await createAgent(cluster.router.url);
    const session = await createSession(cluster.router.url, agentId);

    const slow = openSse(ownerRunner!.url, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "crash during erasure drain" }] }),
    });
    await waitFor(
      () => slow.events.find((event) => event.event === "turn/started"),
      15_000,
      "crash candidate turn starts",
    );
    await assertOwner(cluster, session.id, ownerRunner!);
    const fenceBefore = Number(await cluster.redis.get(`as:fence:{${session.id}}`));

    const request = await requestUserErasure(cluster.router.url, "cluster-erasure-owner-crash");
    await waitForErasureRow(
      request.id,
      (row) => row.status === "draining" && Number(row.claimed) === 0,
      "unclaimed draining phase",
    );

    // Freeze the active owner during the deterministic gap between phases, then wait until the
    // surviving worker holds a live drain claim before simulating an ungraceful machine loss.
    ownerRunner!.pause();
    const claimed = await waitForErasureRow(
      request.id,
      (row) => row.status === "draining" && Number(row.claimed) === 1,
      "live drain claim against frozen owner",
    );
    const [activeBeforeCrash] = await queryDb<{ status: string }>(
      "SELECT status FROM turns WHERE session_id=? ORDER BY started_at_ms DESC LIMIT 1",
      [session.id],
    );
    expect(activeBeforeCrash?.status).toBe("inProgress");
    ownerRunner!.kill();
    await ownerRunner!.exited;
    slow.cancel();

    const leaseKey = `as:lease:{${session.id}}`;
    const leaseDeadline = Number(await cluster.redis.call("PEXPIRETIME", leaseKey));
    expect(leaseDeadline).toBeGreaterThan(Date.now());
    await waitForErasureRow(
      request.id,
      (row) => row.status === "draining" && row.attempts > Number(claimed.attempts),
      "drain retry before the dead owner's session lease expires",
      Math.max(250, leaseDeadline - Date.now() - 50),
    );
    // The retry cadence is shorter than the session TTL. A conflicting runner must not refresh the
    // dead owner's absolute deadline; only natural expiry may open the higher-fence takeover path.
    expect(Number(await cluster.redis.call("PEXPIRETIME", leaseKey))).toBe(leaseDeadline);

    await expectFinalNonPurgeState(request.id, [session], workerRunner!.url);
    const [finalRequest] = await queryDb<{ attempts: number }>(
      "SELECT attempts FROM erasure_requests WHERE request_id=?",
      [request.id],
    );
    // Four phase claims are required without a fault. The extra attempt proves bounded retry after
    // the owner crash rather than an accidental straight-line completion.
    expect(Number(finalRequest?.attempts)).toBeGreaterThanOrEqual(Number(claimed.attempts) + 3);

    const fenceAfter = Number(await cluster.redis.get(`as:fence:{${session.id}}`));
    expect(fenceAfter).toBeGreaterThan(fenceBefore);
    const [turn] = await queryDb<{ status: string; stop_reason: string | null }>(
      "SELECT status, stop_reason FROM turns WHERE session_id=? ORDER BY started_at_ms DESC LIMIT 1",
      [session.id],
    );
    expect(turn).toMatchObject({ status: "interrupted", stop_reason: "interrupted" });

    const outboxes = await queryDb<{ topic: string; total: number }>(
      `SELECT topic, COUNT(*) total FROM lifecycle_outbox
        WHERE aggregate_id=? AND topic IN ('session.tombstoned','session.purge')
        GROUP BY topic ORDER BY topic`,
      [session.id],
    );
    expect(outboxes).toEqual([
      { topic: "session.purge", total: 1 },
      { topic: "session.tombstoned", total: 1 },
    ]);
    const [reconciliation] = await queryDb<{ status: string; row_count: number }>(
      "SELECT status, row_count FROM usage_reconciliations WHERE session_id=?",
      [session.id],
    );
    expect(reconciliation).toMatchObject({ status: "verified" });
    expect(Number(reconciliation?.row_count)).toBe(0);
  }, 120_000);
});
