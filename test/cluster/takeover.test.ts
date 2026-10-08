import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, openSse, queryDb, startCluster, waitFor, type Cluster } from "./harness.js";

/**
 * The M2 acceptance criterion from design §11: real processes, shared MySQL + Redis, kill the lease
 * holder mid-turn and assert the session survives it. Enabled by AGENT_SERVICE_CLUSTER=1 and requires
 * `deploy/local/infra.sh start`.
 */

const enabled = !!process.env.AGENT_SERVICE_CLUSTER;
let cluster: Cluster | undefined;

afterEach(async () => {
  await cluster?.stop();
  cluster = undefined;
});

async function newSession(base: string, opts: { maxSteps?: number } = {}) {
  const agent = await api<{ id: string }>(base, "/v1/agents", {
    method: "POST",
    body: JSON.stringify({
      name: "cluster", instructions: "be brief",
      model: { provider: "deepseek", model: "fake-model" },
      tools: [], limits: { maxSteps: opts.maxSteps ?? 4 },
    }),
  });
  expect(agent.status).toBe(201);
  const session = await api<{ id: string; lastSeq: number }>(base, "/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.body.id }) });
  expect(session.status).toBe(201);
  return session.body;
}

describe.skipIf(!enabled)("cluster: ownership, takeover and replay across processes", () => {
  beforeAll(() => {
    expect(process.env.AGENT_SERVICE_CLUSTER).toBeTruthy();
  });

  it("routes a session consistently and re-routes on 409 without the client noticing", async () => {
    cluster = await startCluster({
      runners: 3,
      // Keep the lease alive for the whole assertion window: the second reply is deliberately slow, so
      // the turn that holds the lease is still running when the 409 and the re-route are checked.
      leaseTtlMs: 30_000,
      leaseHoldMs: 30_000,
      script: [
        { text: "hello from the cluster", ttftMs: 30 },
        { text: "this turn holds the lease", ttftMs: 20_000 },
        ...Array.from({ length: 10 }, () => ({ text: "hello from the cluster", ttftMs: 30 })),
      ],
    });
    const { router, runners } = cluster;
    const session = await newSession(router.url);

    // first turn through the router
    const first = openSse(router.url, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "hi" }] }),
    });
    await first.done;
    expect(first.events.map((e) => e.event)).toContain("turn/completed");

    // the lease directory now names an owner, and it is one of our runners
    const owner = await waitFor(async () => (await cluster!.redis.hget(`as:lease:{${session.id}}`, "addr")) ?? undefined, 5_000, "lease owner");
    expect(runners.map((r) => r.url.replace("http://", ""))).toContain(owner);

    // Hold the lease open so ownership cannot drift while we assert on it: a long-running turn keeps
    // renewing, which is what makes the next two assertions deterministic.
    const holding = openSse(`http://${owner}`, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "hold the lease" }] }),
    });
    await waitFor(() => holding.events.find((e) => e.event === "turn/started"), 15_000, "holding turn started");

    // A request sent straight at a NON-owner must be refused with the owner's address attached.
    const nonOwner = runners.find((r) => !r.url.includes(owner))!;
    const direct = await api(nonOwner.url, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "direct" }], stream: false, busyPolicy: "reject" }),
    });
    expect(direct.status, "a non-owner must refuse, not take over a live session").toBe(409);
    expect(direct.headers.get("x-owner")).toBe(owner);

    // The same request through the router is steered into the running turn, which is only possible if
    // the router followed X-Owner to the runner that holds it.
    const viaRouter = await api<{ turn: { id: string }; steered: boolean }>(router.url, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "via router" }], stream: false }),
    });
    expect(viaRouter.status).toBe(202);
    expect(viaRouter.body.steered, "the router reached the owner, which folded this into its live turn").toBe(true);
    holding.cancel();
  }, 120_000);

  it("SIGKILL of the lease holder mid-turn: another runner takes over, fence advances, no seq gaps", async () => {
    cluster = await startCluster({
      runners: 2,
      leaseTtlMs: 2_000,
      leaseHoldMs: 200,
      // a slow first reply so we can kill the owner while the turn is in flight
      script: [{ text: "this reply is slow on purpose", ttftMs: 8_000 }, ...Array.from({ length: 8 }, () => ({ text: "after takeover" }))],
    });
    const { router, runners, redis } = cluster;
    const session = await newSession(router.url);

    const stream = openSse(router.url, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "start a long turn" }] }),
    });
    await waitFor(() => stream.events.find((e) => e.event === "turn/started"), 15_000, "turn/started");

    const ownerAddr = await waitFor(async () => (await redis.hget(`as:lease:{${session.id}}`, "addr")) ?? undefined, 5_000, "owner");
    const fenceBefore = Number(await redis.get(`as:fence:{${session.id}}`));
    const ownerProc = runners.find((r) => r.url.includes(ownerAddr))!;
    const survivor = runners.find((r) => r !== ownerProc)!;

    ownerProc.kill(); // crash: no drain, lease is left behind to expire
    await ownerProc.exited;
    stream.cancel();

    // the lease expires, then the survivor may start a new turn on the same session
    const next = await waitFor(
      async () => {
        const r = await api<{ turn: { id: string; status: string } }>(survivor.url, `/v1/sessions/${session.id}/turns`, {
          method: "POST",
          body: JSON.stringify({ input: [{ type: "text", text: "after the crash" }], stream: false }),
        });
        return r.status === 202 ? r.body : undefined;
      },
      20_000,
      "survivor accepts a turn",
    );

    const fenceAfter = Number(await redis.get(`as:fence:{${session.id}}`));
    expect(fenceAfter).toBeGreaterThan(fenceBefore);

    // the orphaned turn was closed, and exactly one turn is active/none
    const turns = await queryDb<{ status: string; stop_reason: string | null }>(
      "SELECT status, stop_reason FROM turns WHERE session_id=? ORDER BY started_at_ms",
      [session.id],
    );
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns.some((t) => t.status === "interrupted")).toBe(true);
    expect(turns.filter((t) => t.status === "inProgress").length).toBeLessThanOrEqual(1);

    await waitFor(
      async () => ((await queryDb<{ status: string }>("SELECT status FROM turns WHERE turn_id=?", [next.turn.id]))[0]?.status !== "inProgress" ? true : undefined),
      20_000,
      "second turn finishes",
    );

    // event log has no holes: seq is 1..N with nothing missing
    const rows = await queryDb<{ seq: number }>("SELECT seq FROM events WHERE session_id=? ORDER BY seq", [session.id]);
    const seqs = rows.map((r) => Number(r.seq));
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));

    // and the client can fill the hole it missed while the owner was dying
    const replay = openSse(survivor.url, `/v1/sessions/${session.id}/events?after=0`);
    // Count only events that carry a seq: heartbeats would otherwise satisfy the wait immediately.
    await waitFor(() => (replay.events.filter((e) => e.id !== undefined).length >= seqs.length ? true : undefined), 20_000, "replay catches up");
    replay.cancel();
    const replayed = replay.events.filter((e) => e.id !== undefined).map((e) => e.id!);
    // Exact equality against the full log: comparing a prefix would pass on an empty replay.
    expect(replayed.length).toBeGreaterThanOrEqual(seqs.length);
    expect(replayed.slice(0, seqs.length)).toEqual(seqs);
  }, 180_000);

  it("a stale owner cannot write after being fenced out", async () => {
    cluster = await startCluster({ runners: 2, leaseTtlMs: 2_000, leaseHoldMs: 200, script: [{ text: "slow one", ttftMs: 6_000 }, { text: "quick" }] });
    const { router, runners, redis } = cluster;
    const session = await newSession(router.url);
    const stream = openSse(router.url, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "go" }] }),
    });
    await waitFor(() => stream.events.find((e) => e.event === "turn/started"), 15_000, "turn/started");
    const ownerAddr = await waitFor(async () => (await redis.hget(`as:lease:{${session.id}}`, "addr")) ?? undefined, 5_000, "owner");
    const survivor = runners.find((r) => !r.url.includes(ownerAddr))!;

    // forcibly hand the lease to the survivor while the first turn is still streaming
    await redis.del(`as:lease:{${session.id}}`);
    const taken = await waitFor(
      async () => {
        const r = await api(survivor.url, `/v1/sessions/${session.id}/turns`, {
          method: "POST",
          body: JSON.stringify({ input: [{ type: "text", text: "steal" }], stream: false }),
        });
        return r.status === 202 ? r : undefined;
      },
      20_000,
      "survivor steals the session",
    );
    expect(taken.status).toBe(202);
    stream.cancel();

    // The FENCED runner must be the one that logged it; searching every process's log would also pass
    // when the survivor printed something similar.
    const fenced = runners.find((r) => r.url.includes(ownerAddr))!;
    await waitFor(() => (fenced.log.some((l) => /fenced out|no longer owns/i.test(l)) ? true : undefined), 20_000, "the fenced runner logs it");
    const rows = await queryDb<{ seq: number }>("SELECT seq FROM events WHERE session_id=? ORDER BY seq", [session.id]);
    const seqs = rows.map((r) => Number(r.seq));
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  }, 180_000);

  it("a new runner repairs and archives an orphaned active turn after lease takeover", async () => {
    cluster = await startCluster({
      runners: 2,
      leaseTtlMs: 6_000,
      leaseHoldMs: 200,
      script: [{ text: "too late from the stale owner", ttftMs: 12_000 }],
    });
    const { router, runners, redis } = cluster;
    const session = await newSession(router.url);
    const stream = openSse(router.url, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "start lifecycle takeover" }] }),
    });
    const started = await waitFor(
      () => stream.events.find((event) => event.event === "turn/started"),
      15_000,
      "orphan candidate turn starts",
    );
    const turnId = (started.data.turn as { id: string }).id;
    const ownerAddr = await waitFor(
      async () => (await redis.hget(`as:lease:{${session.id}}`, "addr")) ?? undefined,
      5_000,
      "lifecycle owner",
    );
    const staleOwner = runners.find((runner) => runner.url.includes(ownerAddr))!;
    const successor = runners.find((runner) => runner !== staleOwner)!;
    const fenceBefore = Number(await redis.get(`as:fence:{${session.id}}`));

    // Simulate a lost Redis lease without killing the process. The successor must use the higher
    // fence to repair the durable active turn before it can atomically archive the session.
    await redis.del(`as:lease:{${session.id}}`);
    const archived = await waitFor(
      async () => {
        const response = await api<{ archivedAtMs?: number }>(successor.url, `/v1/sessions/${session.id}/archive`, { method: "POST" });
        return response.status === 200 ? response : undefined;
      },
      20_000,
      "successor archives orphan",
    );
    expect(archived.body.archivedAtMs).toEqual(expect.any(Number));
    const fenceAfter = Number(await redis.get(`as:fence:{${session.id}}`));
    expect(fenceAfter).toBeGreaterThan(fenceBefore);

    await waitFor(
      () => (staleOwner.log.some((line) => /lease lost|fenced out|no longer owns/i.test(line)) ? true : undefined),
      15_000,
      "stale lifecycle owner stops",
    );
    stream.cancel();

    const [sessionRow] = await queryDb<{ status: string; archived_at_ms: number | null; fence_token: number }>(
      "SELECT JSON_UNQUOTE(JSON_EXTRACT(status, '$.type')) status, archived_at_ms, fence_token FROM sessions WHERE session_id=?",
      [session.id],
    );
    expect(sessionRow).toMatchObject({ status: "idle", archived_at_ms: expect.any(Number), fence_token: fenceAfter });
    const [turnRow] = await queryDb<{ status: string; stop_reason: string | null }>(
      "SELECT status, stop_reason FROM turns WHERE turn_id=?",
      [turnId],
    );
    expect(turnRow).toMatchObject({ status: "interrupted", stop_reason: "interrupted" });

    const blocked = await api<{ error: { code: string } }>(staleOwner.url, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "stale retry" }], stream: false }),
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("session_archived");

    const rows = await queryDb<{ seq: number }>("SELECT seq FROM events WHERE session_id=? ORDER BY seq", [session.id]);
    const seqs = rows.map((row) => Number(row.seq));
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
  }, 180_000);

  it("linearizes archive against an active turn and restores the session without event gaps", async () => {
    cluster = await startCluster({
      runners: 2,
      leaseTtlMs: 5_000,
      leaseHoldMs: 500,
      script: [{ text: "slow lifecycle turn", ttftMs: 10_000 }, { text: "after unarchive", ttftMs: 20 }],
    });
    const { router } = cluster;
    const session = await newSession(router.url);

    const stream = openSse(router.url, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "hold for archive race" }] }),
    });
    const started = await waitFor(
      () => stream.events.find((event) => event.event === "turn/started"),
      15_000,
      "lifecycle turn starts",
    );
    const turnId = (started.data.turn as { id: string }).id;

    const busyArchive = await api<{ error: { code: string } }>(router.url, `/v1/sessions/${session.id}/archive`, { method: "POST" });
    expect(busyArchive.status).toBe(409);
    expect(busyArchive.body.error.code).toBe("session_busy");

    const interrupted = await api(router.url, `/v1/sessions/${session.id}/turns/${turnId}/interrupt`, { method: "POST" });
    expect(interrupted.status).toBe(200);
    await stream.done;
    await waitFor(
      async () => ((await queryDb<{ status: string }>("SELECT JSON_UNQUOTE(JSON_EXTRACT(status, '$.type')) status FROM sessions WHERE session_id=?", [session.id]))[0]?.status === "idle" ? true : undefined),
      15_000,
      "interrupted session becomes idle",
    );

    const archived = await api<{ archivedAtMs?: number }>(router.url, `/v1/sessions/${session.id}/archive`, { method: "POST" });
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAtMs).toEqual(expect.any(Number));
    const blockedTurn = await api<{ error: { code: string } }>(router.url, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "blocked" }], stream: false }),
    });
    expect(blockedTurn.status).toBe(409);
    expect(blockedTurn.body.error.code).toBe("session_archived");
    expect((await api(router.url, `/v1/sessions/${session.id}/items`)).status).toBe(200);

    const unarchived = await api<{ archivedAtMs?: number }>(router.url, `/v1/sessions/${session.id}/unarchive`, { method: "POST" });
    expect(unarchived.status).toBe(200);
    expect(unarchived.body.archivedAtMs).toBeUndefined();
    const resumed = await api(router.url, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "restored" }], stream: false }),
    });
    expect(resumed.status).toBe(202);

    const rows = await waitFor(
      async () => {
        const events = await queryDb<{ seq: number; type: string }>("SELECT seq, type FROM events WHERE session_id=? ORDER BY seq", [session.id]);
        return events.some((event) => event.type === "session/unarchived") ? events : undefined;
      },
      15_000,
      "lifecycle events persist",
    );
    const seqs = rows.map((row) => Number(row.seq));
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
    expect(rows.map((row) => row.type)).toEqual(expect.arrayContaining(["session/archived", "session/unarchived"]));
  }, 120_000);

  it("SIGTERM drains: the in-flight turn completes normally and the lease is released", async () => {
    // A long lease TTL so a released lease can only mean the drain released it, not that it expired.
    cluster = await startCluster({ runners: 2, leaseTtlMs: 60_000, leaseHoldMs: 100, script: [{ text: "finishing before shutdown", ttftMs: 1_500 }] });
    const { router, runners, redis } = cluster;
    const session = await newSession(router.url);
    const stream = openSse(router.url, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "go" }] }),
    });
    await waitFor(() => stream.events.find((e) => e.event === "turn/started"), 15_000, "turn/started");
    const ownerAddr = await waitFor(async () => (await redis.hget(`as:lease:{${session.id}}`, "addr")) ?? undefined, 5_000, "owner");
    const ownerProc = runners.find((r) => r.url.includes(ownerAddr))!;

    ownerProc.term();
    await ownerProc.exited;
    await stream.done;

    // the turn finished on its own terms, not as an interruption
    const [turn] = await queryDb<{ status: string; stop_reason: string }>("SELECT status, stop_reason FROM turns WHERE session_id=?", [session.id]);
    expect(turn?.status).toBe("completed");
    expect(turn?.stop_reason).toBe("end_turn");
    expect(await redis.exists(`as:lease:{${session.id}}`)).toBe(0);
    expect(stream.events.map((e) => e.event)).toContain("turn/completed");
  }, 120_000);
});
