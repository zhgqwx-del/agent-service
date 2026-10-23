import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemorySessionStore, attachSessionWriteAdmission, createSessionAcquireCommand, newErasureRequestId, userErasureRequestHash,
  type SessionAcquireCommand, type SessionAcquireInput, type SessionLeaseProof, type ErasureWriteAuthorization } from "../src/index.js";
import { mkSession } from "./conformance.js";

async function fixture() {
  let now = Date.now(); const store = new MemorySessionStore({ now: () => now }), session = mkSession();
  await store.createSession(session);
  const principal = { tenantId: session.tenantId, userId: session.userId }, bootId = randomUUID();
  const input = (expectedFence: number, overrides: Partial<SessionAcquireInput> = {}): SessionAcquireInput => ({
    sessionId: session.id, principal, runnerId: "same-configured-runner", runnerAddr: "http://127.0.0.1:10001",
    bootId, acquisitionId: randomUUID(), expectedFence, ttlMs: 1000, ...overrides,
  });
  const acquire = async (command: SessionAcquireCommand) => {
    const result = await store.sessionAuthority.acquire(command); expect(result.ok).toBe(true);
    if (!result.ok) throw Error("fixture lease unavailable"); return result;
  };
  return { store, session, input, acquire, advance(ms: number) { now += ms; }, now: () => now };
}

async function draining(f: Awaited<ReturnType<typeof fixture>>): Promise<ErasureWriteAuthorization> {
  const requestId = newErasureRequestId(), { tenantId, userId } = f.session;
  await f.store.requestUserErasure({ requestId, tenantId, userId, requestedByKeyId: "authority-fixture-admin",
    idempotencyKey: requestId, requestHash: userErasureRequestHash(tenantId, userId), atMs: f.now() });
  let [job] = await f.store.claimErasureJobs({ nowMs: f.now(), limit: 1, leaseMs: 60_000, claimToken: "authority-gated-claim" });
  if (!job?.claimToken) throw Error("fixture erasure claim unavailable");
  await f.store.transitionErasureJob({ tenantId, subjectKind: "user", subjectId: userId, requestId,
    subjectGeneration: job.subjectGeneration, claimToken: job.claimToken, claimAttempt: job.attempts },
    { fromStatus: "gated", toStatus: "draining", atMs: f.now() + 1, availableAtMs: f.now() + 1 });
  f.advance(1);
  [job] = await f.store.claimErasureJobs({ nowMs: f.now(), limit: 1, leaseMs: 60_000, claimToken: "authority-draining-claim" });
  if (!job?.claimToken) throw Error("fixture draining claim unavailable");
  return { tenantId, userId, requestId, subjectGeneration: job.subjectGeneration, claimToken: job.claimToken, claimAttempt: job.attempts };
}

describe("single store-owned session authority", () => {
  it("confirms the exact command without another fence, event or expiry extension", async () => {
    const f = await fixture();
    try {
      const command = createSessionAcquireCommand(f.input(0)), granted = await f.acquire(command);
      const before = await f.store.sessionAuthority.getOwner(f.session.id); f.advance(100);
      const confirmed = await f.store.sessionAuthority.confirm(command);
      expect(confirmed).toMatchObject({ ok: true, fence: granted.fence });
      expect(await f.store.sessionAuthority.getOwner(f.session.id)).toMatchObject({ fence: 1, expiresAtDbMs: before!.expiresAtDbMs });
      expect(await f.store.getSession(f.session.tenantId, f.session.id)).toMatchObject({ fenceToken: 1, lastSeq: 1 });
      expect(await f.store.readEvents(f.session.id, 0, 100)).toHaveLength(1);
    } finally { await f.store.close(); }
  });

  it("keeps same-RUNNER_ID boots distinct and rejects late old renew and release", async () => {
    const f = await fixture();
    try {
      const first = await f.acquire(createSessionAcquireCommand(f.input(0)));
      const next = createSessionAcquireCommand(f.input(1, { bootId: randomUUID() }));
      expect(await f.store.sessionAuthority.acquire(next)).toMatchObject({ ok: false, reason: "busy" });
      f.advance(1001); const second = await f.acquire(next);
      expect(second.fence).toBe(2); expect(await f.store.sessionAuthority.renew(first.proof, 1000)).toBe(false);
      await f.store.sessionAuthority.release(first.proof);
      expect(await f.store.sessionAuthority.getOwner(f.session.id)).toMatchObject({ fence: 2 });
      expect(await f.store.sessionAuthority.renew(second.proof, 1000)).toBe(true);
    } finally { await f.store.close(); }
  });

  it("does not refresh a stale floor or resurrect a released exact command", async () => {
    const f = await fixture();
    try {
      const stale = createSessionAcquireCommand(f.input(0)), firstCommand = createSessionAcquireCommand(f.input(0));
      const first = await f.acquire(firstCommand); await f.store.sessionAuthority.release(first.proof);
      expect(await f.store.sessionAuthority.confirm(firstCommand)).toEqual({ ok: false, reason: "lost" });
      expect(await f.store.sessionAuthority.acquire(firstCommand)).toEqual({ ok: false, reason: "lost" });
      expect(await f.store.sessionAuthority.acquire(stale)).toMatchObject({ ok: false, reason: "stale" });
      expect((await f.acquire(createSessionAcquireCommand(f.input(1)))).fence).toBe(2);
    } finally { await f.store.close(); }
  });

  it("cannot confirm the same acquisition nonce with changed TTL or predecessor", async () => {
    const f = await fixture();
    try {
      const original = f.input(0); await f.acquire(createSessionAcquireCommand(original));
      expect(await f.store.sessionAuthority.confirm(createSessionAcquireCommand({ ...original, ttlMs: 2000 }))).toMatchObject({ ok: false, reason: "lost" });
      expect(await f.store.sessionAuthority.confirm(createSessionAcquireCommand({ ...original, expectedFence: 1 }))).toMatchObject({ ok: false, reason: "lost" });
      expect(await f.store.sessionAuthority.getOwner(f.session.id)).toMatchObject({ fence: 1, expiresAtDbMs: f.now() + 1000 });
    } finally { await f.store.close(); }
  });

  it("rejects equal numeric-only writes and an admitted batch changed before commit", async () => {
    const f = await fixture();
    try {
      const granted = await f.acquire(createSessionAcquireCommand(f.input(0)));
      await expect(f.store.commit({ sessionId: f.session.id, fence: granted.fence, events: [] })).rejects.toThrow("Session authority");
      const mutated = attachSessionWriteAdmission({ sessionId: f.session.id, fence: granted.fence, events: [], expectedLastSeq: 1 }, granted.proof);
      mutated.expectedLastSeq = 2;
      await expect(f.store.commit(mutated)).rejects.toThrow("Session authority");
      const result = await f.store.commit(attachSessionWriteAdmission({ sessionId: f.session.id, fence: granted.fence, events: [], expectedLastSeq: 1 }, granted.proof));
      expect(result).toMatchObject({ lastSeq: 1 });
    } finally { await f.store.close(); }
  });

  it("requires a genuinely issued proof instead of a caller-created lookalike", async () => {
    const f = await fixture();
    try {
      await expect(f.store.sessionAuthority.renew(Object.freeze({}) as SessionLeaseProof, 1000)).rejects.toThrow("Session authority");
      expect(() => attachSessionWriteAdmission({ sessionId: f.session.id, fence: 1 }, {} as SessionLeaseProof)).toThrow("Session authority");
      expect(await f.store.sessionAuthority.getOwner(f.session.id)).toBeNull();
    } finally { await f.store.close(); }
  });

  it("keeps independent Memory stores in distinct authority namespaces", async () => {
    const a = await fixture(), b = await fixture();
    try {
      const first = await a.store.sessionAuthority.identity(), second = await b.store.sessionAuthority.identity();
      expect(first.backend).toBe("memory"); expect(first.namespaceSha256).not.toBe(second.namespaceSha256);
      const proof = (await a.acquire(createSessionAcquireCommand(a.input(0)))).proof;
      await expect(b.store.sessionAuthority.renew(proof, 1000)).resolves.toBe(false);
    } finally { await a.store.close(); await b.store.close(); }
  });

  it("does not let an actual erasure claim steal another boot's still-live lease", async () => {
    const f = await fixture();
    try {
      await f.acquire(createSessionAcquireCommand(f.input(0)));
      const authorization = await draining(f);
      const remote = createSessionAcquireCommand(f.input(1, { bootId: randomUUID() }));
      expect(await f.store.sessionAuthority.acquireForErasure(remote, authorization)).toMatchObject({ ok: false, reason: "busy" });
      expect(await f.store.sessionAuthority.getOwner(f.session.id)).toMatchObject({ fence: 1 });
      expect(await f.store.getErasureSessionHead(authorization, f.session.id)).toMatchObject({ fenceToken: 1 });
    } finally { await f.store.close(); }
  });

  it("hands a local live lease to an exact erasure claim only with its current predecessor proof", async () => {
    const f = await fixture();
    try {
      const old = await f.acquire(createSessionAcquireCommand(f.input(0))), authorization = await draining(f);
      const command = createSessionAcquireCommand(f.input(1));
      const granted = await f.store.sessionAuthority.acquireForErasure(command, authorization, old.proof);
      expect(granted).toMatchObject({ ok: true, fence: 2 }); if (!granted.ok) throw Error("fixture handoff unavailable");
      expect(await f.store.sessionAuthority.renew(old.proof, 1000)).toBe(false);
      expect(await f.store.sessionAuthority.renew(granted.proof, 1000)).toBe(true);
      await f.store.applyErasureSessionAction(attachSessionWriteAdmission({ authority: authorization, sessionId: f.session.id,
        action: "fence" as const, fence: granted.fence }, granted.proof));
      const before = await f.store.sessionAuthority.getOwner(f.session.id); f.advance(1);
      expect(await f.store.sessionAuthority.confirmForErasure(command, authorization)).toMatchObject({ ok: true, fence: 2 });
      expect(await f.store.sessionAuthority.getOwner(f.session.id)).toMatchObject({ expiresAtDbMs: before!.expiresAtDbMs });
      await expect(f.store.sessionAuthority.confirmForErasure(command, { ...authorization, claimToken: "replacement-claim" })).rejects.toThrow("Session authority");
      await f.store.sessionAuthority.release(old.proof);
      expect(await f.store.sessionAuthority.getOwner(f.session.id)).toMatchObject({ fence: 2 });
    } finally { await f.store.close(); }
  });

  it("permits an actual erasure claim after expiry without a remote predecessor proof", async () => {
    const f = await fixture();
    try {
      await f.acquire(createSessionAcquireCommand(f.input(0))); const authorization = await draining(f); f.advance(1001);
      const granted = await f.store.sessionAuthority.acquireForErasure(createSessionAcquireCommand(f.input(1, { bootId: randomUUID() })), authorization);
      expect(granted).toMatchObject({ ok: true, fence: 2 });
      expect(await f.store.getErasureSessionHead(authorization, f.session.id)).toMatchObject({ fenceToken: 2 });
    } finally { await f.store.close(); }
  });


  it("keeps admission write-once while allowing same-proof same-body attachment", async () => {
    const f = await fixture();
    try {
      const command = createSessionAcquireCommand(f.input(0)), first = await f.acquire(command);
      const batch = { sessionId: f.session.id, fence: first.fence, expectedLastSeq: 1, events: [] };
      expect(attachSessionWriteAdmission(batch, first.proof)).toBe(batch);
      expect(attachSessionWriteAdmission(batch, first.proof)).toBe(batch);
      const confirmed = await f.store.sessionAuthority.confirm(command);
      if (!confirmed.ok) throw Error("fixture confirmation unavailable");
      expect(() => attachSessionWriteAdmission(batch, confirmed.proof)).toThrow("Session authority");
      expect(await f.store.commit(batch)).toMatchObject({ lastSeq: 1 });
      expect(await f.store.commit(attachSessionWriteAdmission({ ...batch }, confirmed.proof))).toMatchObject({ lastSeq: 1 });
    } finally { await f.store.close(); }
  });

  it("cannot overwrite an admitted body's old digest after changing its contents", async () => {
    const f = await fixture();
    try {
      const first = await f.acquire(createSessionAcquireCommand(f.input(0)));
      const batch = attachSessionWriteAdmission({ sessionId: f.session.id, fence: first.fence, expectedLastSeq: 1, events: [] }, first.proof);
      batch.expectedLastSeq = 2;
      expect(() => attachSessionWriteAdmission(batch, first.proof)).toThrow("Session authority");
      await expect(f.store.commit(batch)).rejects.toThrow("Session authority");
      expect(await f.store.readEvents(f.session.id, 0, 100)).toHaveLength(1);
      expect(await f.store.getSession(f.session.tenantId, f.session.id)).toMatchObject({ lastSeq: 1, fenceToken: 1 });
    } finally { await f.store.close(); }
  });

});
