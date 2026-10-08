import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  MysqlSessionStore,
  newErasureRequestId,
  userErasureRequestHash,
} from "../../packages/store/src/index.js";
import {
  api,
  MYSQL_URL,
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
  control_generation: number;
  quarantined_at_ms: number | null;
  quarantine_reason_code: string | null;
  quarantine_evidence_sha256: string | null;
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

async function createAgent(base: string, userId = "u_cluster"): Promise<string> {
  const response = await api<{ id: string }>(base, "/v1/agents", {
    method: "POST",
    headers: { "x-user-id": userId },
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
  userId = "u_cluster",
): Promise<SessionRef> {
  const response = await api<SessionRef>(base, "/v1/sessions", {
    method: "POST",
    headers: { "x-user-id": userId },
    body: JSON.stringify({
      agentId,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
    }),
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function requestUserErasure(
  base: string,
  idempotencyKey: string,
  userId = "u_cluster",
): Promise<ErasureResponse> {
  const response = await api<ErasureResponse>(base, "/v1/data-erasure-requests", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey, "x-user-id": userId },
  });
  expect(response.status).toBe(202);
  expect(response.body.status).toBe("gated");
  return response.body;
}

async function seedUserErasure(
  store: MysqlSessionStore,
  idempotencyKey: string,
  userId: string,
): Promise<ErasureResponse> {
  const record = await store.requestUserErasure({
    requestId: newErasureRequestId(),
    tenantId: "t_cluster",
    userId,
    requestedByKeyId: "cluster-maintainer",
    idempotencyKey,
    requestHash: userErasureRequestHash("t_cluster", userId),
    atMs: Date.now(),
  });
  expect(record.status).toBe("gated");
  return { id: record.requestId, status: record.status };
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
              available_at_ms, lease_until_ms, control_generation, quarantined_at_ms,
              quarantine_reason_code, quarantine_evidence_sha256
         FROM erasure_requests WHERE request_id=?`,
      [requestId],
    );
    return row && predicate(row) ? row : undefined;
  }, timeoutMs, label);
}

async function seedPolicyActivatedPurging(requestId: string): Promise<{
  attempts: number;
  claimToken: string;
  leaseUntilMs: number;
}> {
  const [request] = await queryDb<{ generation: number; gated_at_ms: number }>(
    "SELECT generation, gated_at_ms FROM erasure_requests WHERE request_id=?",
    [requestId],
  );
  if (!request) throw new Error("purging seed request not found");
  const generation = Number(request.generation);
  const gatedAtMs = Number(request.gated_at_ms);
  const policyVersion = "cluster-policy-v1";
  const policyHash = "b".repeat(64);
  const transitions = [
    ["gated", "draining"],
    ["draining", "tombstoning"],
    ["tombstoning", "reconciling_usage"],
    ["reconciling_usage", "awaiting_purge_policy"],
    ["awaiting_purge_policy", "purging"],
  ] as const;
  for (const [index, [fromStatus, status]] of transitions.entries()) {
    const carriesPolicy = status === "purging";
    await queryDb(
      `INSERT INTO erasure_audit_events
         (request_id, seq, event_type, payload, emitted_at_ms)
       VALUES (?, ?, 'erasure/status_changed', ?, ?)`,
      [
        requestId,
        index + 2,
        JSON.stringify({
          fromStatus,
          status,
          generation,
          ...(carriesPolicy ? { policyVersion, policyHash } : {}),
        }),
        gatedAtMs + index + 1,
      ],
    );
  }
  const attempts = 4;
  const claimToken = "legacy-purge-worker";
  const leaseUntilMs = Date.now() + 120_000;
  await queryDb(
    `UPDATE erasure_requests
        SET status='purging', updated_at_ms=?, available_at_ms=?, attempts=?,
            claim_token=?, lease_until_ms=?, policy_version=?, policy_hash=?
      WHERE request_id=?`,
    [
      gatedAtMs + transitions.length,
      gatedAtMs + transitions.length,
      attempts,
      claimToken,
      leaseUntilMs,
      policyVersion,
      policyHash,
      requestId,
    ],
  );
  return { attempts, claimToken, leaseUntilMs };
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
  userId = "u_cluster",
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
    { headers: { "x-user-id": userId } },
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
    expect((await api(statusBase, `/v1/sessions/${session.id}`, {
      headers: { "x-user-id": userId },
    })).status).toBe(404);
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

  it("quarantines claim poison without starving its neighbor and resumes only through audited repair", async () => {
    cluster = await startCluster({
      ...workerClusterOptions,
      erasureWorkerEnabledForRunner: (runnerNumber) => runnerNumber !== 2,
      dataErasureRequestsEnabledForRunner: (runnerNumber) => runnerNumber === 1,
      runnerEnv: (runnerNumber: number) => ({
        ERASURE_WORKER_POLL_MS: runnerNumber === 2 ? "300000" : "200",
      }),
    });
    const [workerRunner, lowFrequencyRunner] = cluster.runners;
    workerRunner!.pause();

    const poisonUser = "u_cluster_poison";
    const validUser = "u_cluster_valid";
    const purgingUser = "u_cluster_purging";
    const poisonAgent = await createAgent(lowFrequencyRunner!.url, poisonUser);
    const validAgent = await createAgent(lowFrequencyRunner!.url, validUser);
    const poisonSession = await createSession(
      lowFrequencyRunner!.url,
      poisonAgent,
      undefined,
      poisonUser,
    );
    const validSession = await createSession(
      lowFrequencyRunner!.url,
      validAgent,
      undefined,
      validUser,
    );

    // runner-2 deliberately has neither admission nor a worker. Seed the jobs through the same
    // real MySQL store contract used by runner HTTP after runner-1 is frozen, so no initial poll can
    // race the controlled poison fixture while ordinary resources still came through runner HTTP.
    const poisonIdempotency = "cluster-poison-sensitive-idempotency";
    const seeder = await MysqlSessionStore.connect({ url: MYSQL_URL, connectionLimit: 1 });
    let poison: ErasureResponse;
    let valid: ErasureResponse;
    let purging: ErasureResponse;
    try {
      poison = await seedUserErasure(seeder, poisonIdempotency, poisonUser);
      valid = await seedUserErasure(seeder, "cluster-valid-neighbor", validUser);
      purging = await seedUserErasure(seeder, "cluster-seeded-purging", purgingUser);
    } finally {
      await seeder.close();
    }
    const seededPurging = await seedPolicyActivatedPurging(purging.id);

    // Corrupt only the oldest candidate's main audit. Explicit availability values make candidate
    // ordering deterministic even if both HTTP requests share the same millisecond timestamp.
    await queryDb(
      `UPDATE erasure_requests
          SET available_at_ms=CASE request_id WHEN ? THEN 1 WHEN ? THEN 2 END
        WHERE request_id IN (?,?)`,
      [poison.id, valid.id, poison.id, valid.id],
    );
    await queryDb("DELETE FROM erasure_audit_events WHERE request_id=?", [poison.id]);
    const ordered = await queryDb<{ request_id: string }>(
      `SELECT request_id FROM erasure_requests
        WHERE request_id IN (?,?)
        ORDER BY available_at_ms, request_id`,
      [poison.id, valid.id],
    );
    expect(ordered.map((row) => row.request_id)).toEqual([poison.id, valid.id]);
    const [missingAudit] = await queryDb<{ total: number }>(
      "SELECT COUNT(*) total FROM erasure_audit_events WHERE request_id=?",
      [poison.id],
    );
    expect(Number(missingAudit?.total)).toBe(0);

    workerRunner!.resume();
    const quarantined = await waitForErasureRow(
      poison.id,
      (row) => (
        row.status === "gated"
        && row.quarantined_at_ms !== null
        && row.quarantine_reason_code === "audit_chain_invalid"
      ),
      "oldest poison is durably quarantined",
    );
    expect(Number(quarantined.control_generation)).toBe(1);
    expect(Number(quarantined.attempts)).toBe(0);
    expect(Number(quarantined.claimed)).toBe(0);
    expect(quarantined.available_at_ms).toBeNull();
    expect(quarantined.lease_until_ms).toBeNull();
    expect(quarantined.quarantine_evidence_sha256).toMatch(/^[0-9a-f]{64}$/);

    await expectFinalNonPurgeState(
      valid.id,
      [validSession],
      lowFrequencyRunner!.url,
      validUser,
    );

    const publicPoison = await api<Record<string, unknown>>(
      lowFrequencyRunner!.url,
      `/v1/data-erasure-requests/${poison.id}`,
      { headers: { "x-user-id": poisonUser } },
    );
    expect(publicPoison.status).toBe(200);
    expect(publicPoison.headers.get("cache-control")).toBe("no-store");
    expect(publicPoison.body).toMatchObject({ id: poison.id, status: "blocked" });
    expect(Object.keys(publicPoison.body).sort()).toEqual([
      "createdAtMs", "generation", "id", "scope", "status", "updatedAtMs", "userId",
    ]);
    const publicJson = JSON.stringify(publicPoison.body);
    expect(publicJson).not.toContain("audit_chain_invalid");
    expect(publicJson).not.toContain(quarantined.quarantine_evidence_sha256!);

    const firstControlEvents = await queryDb<{
      control_generation: number;
      event_type: string;
      phase: string;
      reason_code: string;
      action_code: string | null;
      actor_key_id: string | null;
      before_sha256: string;
      after_sha256: string | null;
    }>(
      `SELECT control_generation, event_type, phase, reason_code, action_code,
              actor_key_id, before_sha256, after_sha256
         FROM erasure_job_control_events
        WHERE request_id=? ORDER BY control_event_id`,
      [poison.id],
    );
    expect(firstControlEvents).toEqual([expect.objectContaining({
      event_type: "erasure_job/quarantined",
      phase: "gated",
      reason_code: "audit_chain_invalid",
      action_code: null,
      actor_key_id: null,
      before_sha256: quarantined.quarantine_evidence_sha256,
      after_sha256: null,
    })]);
    expect(Number(firstControlEvents[0]?.control_generation)).toBe(1);
    expect(JSON.stringify(firstControlEvents)).not.toContain(poisonIdempotency);
    expect(JSON.stringify(firstControlEvents)).not.toContain(poisonUser);

    // Freeze the original worker and give the replacement a visible probe job. Observing the probe
    // advance proves the replacement really polled before we assert that active quarantine stayed
    // unavailable without another attempt or duplicate control event.
    workerRunner!.pause();
    const restartSeeder = await MysqlSessionStore.connect({ url: MYSQL_URL, connectionLimit: 1 });
    let restartProbe: ErasureResponse;
    try {
      restartProbe = await seedUserErasure(
        restartSeeder,
        "cluster-restart-worker-probe",
        "u_cluster_restart_probe",
      );
    } finally {
      await restartSeeder.close();
    }
    await cluster.addRunner();
    await waitForErasureRow(
      restartProbe.id,
      (row) => row.status !== "gated" && Number(row.attempts) > 0,
      "replacement worker completes a visible poll",
    );
    const afterNewWorker = await waitForErasureRow(
      poison.id,
      (row) => row.quarantined_at_ms !== null,
      "quarantine remains after a new worker poll",
    );
    expect(Number(afterNewWorker.control_generation)).toBe(1);
    expect(Number(afterNewWorker.attempts)).toBe(0);
    const [controlCount] = await queryDb<{ total: number }>(
      "SELECT COUNT(*) total FROM erasure_job_control_events WHERE request_id=?",
      [poison.id],
    );
    expect(Number(controlCount?.total)).toBe(1);

    const maintenance = await MysqlSessionStore.connect({ url: MYSQL_URL, connectionLimit: 1 });
    try {
      const identity = {
        tenantId: "t_cluster",
        subjectKind: "user" as const,
        subjectId: poisonUser,
        requestId: poison.id,
        subjectGeneration: 1,
      };
      const inspection = await maintenance.inspectErasureJobIntervention(identity);
      expect(inspection).toMatchObject({
        requestId: poison.id,
        phase: "gated",
        controlGeneration: 1,
        kind: "quarantine",
        reasonCode: "audit_chain_invalid",
        evidenceSha256: quarantined.quarantine_evidence_sha256,
      });
      expect(inspection?.allowedActions).toContain("restore_initial_gate_audit");
      expect(await maintenance.repairAndResumeErasureJob({
        ...identity,
        expectedControlGeneration: inspection!.controlGeneration,
        expectedEvidenceSha256: inspection!.evidenceSha256,
        actorKeyId: "cluster-maintainer",
        actionCode: "restore_initial_gate_audit",
        atMs: Date.now(),
      })).toBe(true);
    } finally {
      await maintenance.close();
    }

    await expectFinalNonPurgeState(
      poison.id,
      [poisonSession],
      lowFrequencyRunner!.url,
      poisonUser,
    );
    const repairedControlEvents = await queryDb<{
      control_generation: number;
      event_type: string;
      reason_code: string;
      action_code: string | null;
      actor_key_id: string | null;
      before_sha256: string;
      after_sha256: string | null;
    }>(
      `SELECT control_generation, event_type, reason_code, action_code, actor_key_id,
              before_sha256, after_sha256
         FROM erasure_job_control_events
        WHERE request_id=? ORDER BY control_event_id`,
      [poison.id],
    );
    expect(repairedControlEvents).toHaveLength(2);
    expect(repairedControlEvents[1]).toMatchObject({
      event_type: "erasure_job/quarantine_repaired",
      reason_code: "audit_chain_invalid",
      action_code: "restore_initial_gate_audit",
      actor_key_id: "cluster-maintainer",
      before_sha256: quarantined.quarantine_evidence_sha256,
    });
    expect(Number(repairedControlEvents[1]?.control_generation)).toBe(2);
    const controlJson = JSON.stringify(repairedControlEvents);
    expect(controlJson).not.toContain(poisonIdempotency);
    expect(controlJson).not.toContain(poisonUser);

    // The ordinary worker neither adopts an old purging claim nor activates any session.purge
    // intent. Both remain byte-for-byte authority boundaries while other jobs finish.
    const [purgingAfter] = await queryDb<{
      status: string;
      attempts: number;
      claim_token: string | null;
      lease_until_ms: number | null;
      quarantined_at_ms: number | null;
    }>(
      `SELECT status, attempts, claim_token, lease_until_ms, quarantined_at_ms
         FROM erasure_requests WHERE request_id=?`,
      [purging.id],
    );
    expect(purgingAfter).toMatchObject({
      status: "purging",
      claim_token: seededPurging.claimToken,
      quarantined_at_ms: null,
    });
    expect(Number(purgingAfter?.attempts)).toBe(seededPurging.attempts);
    expect(Number(purgingAfter?.lease_until_ms)).toBe(seededPurging.leaseUntilMs);
    const purgeIntents = await queryDb<{
      aggregate_id: string;
      available_at_ms: number | null;
      attempts: number;
      claim_token: string | null;
      lease_until_ms: number | null;
      completed_at_ms: number | null;
      dead_lettered_at_ms: number | null;
    }>(
      `SELECT aggregate_id, available_at_ms, attempts, claim_token, lease_until_ms,
              completed_at_ms, dead_lettered_at_ms
         FROM lifecycle_outbox
        WHERE topic='session.purge' AND aggregate_id IN (?,?)
        ORDER BY aggregate_id`,
      [poisonSession.id, validSession.id],
    );
    expect(purgeIntents).toHaveLength(2);
    expect(purgeIntents.every((intent) => (
      intent.available_at_ms === null
      && Number(intent.attempts) === 0
      && intent.claim_token === null
      && intent.lease_until_ms === null
      && intent.completed_at_ms === null
      && intent.dead_lettered_at_ms === null
    ))).toBe(true);
  }, 180_000);
});
