import { randomUUID } from "node:crypto";
import { emptyUsage, DEFAULT_AUTH_POLICY } from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import { MemorySessionStore, newUsageId, newErasureRequestId, userErasureRequestHash,
  tenantErasureRequestHash, ORDINARY_SESSION_DELETE_GRACE_MS,
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  ordinaryUsageRetentionReceiptSha256, type RetentionPolicyDocumentV1 } from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const DAY = 86400000;
const policy = (duration: number | null): RetentionPolicyDocumentV1 => ({
  sessionContentRetentionMs: 30 * DAY, userErasureGraceMs: 30 * DAY,
  operationalUsageRetentionMs: duration, idempotencyReceiptRetentionMs: null,
  billingFactRetentionMs: null, lifecycleAuditRetentionMs: null, exportArtifactTtlMs: DAY,
});
async function fixture(options: { duration?: number | null; configured?: boolean; ordinary?: boolean; empty?: boolean;
  store?: MemorySessionStore; sessionId?: string; usageCount?: number; nowMs?: number } = {}) {
  let clock = options.nowMs ?? Date.now();
  const store = options.store ?? new MemorySessionStore({ now: () => clock });
  const session = mkSession(`tenant-ordinary-usage-${randomUUID()}`, `user-ordinary-usage-${randomUUID()}`);
  if (options.sessionId) session.id = options.sessionId;
  await store.setTenantAuth(session.tenantId, DEFAULT_AUTH_POLICY);
  async function activate(duration: number | null, version: string = randomUUID()) {
    await store.putRetentionPolicy({ tenantId: session.tenantId, policyVersion: version,
      policy: policy(duration), actorKeyId: "admin", atMs: clock });
    const current = await store.getActiveRetentionPolicy(session.tenantId);
    await store.activateRetentionPolicy({ tenantId: session.tenantId, policyVersion: version,
      expectedControlGeneration: current?.control.controlGeneration ?? 0, actorKeyId: "admin", atMs: clock });
  }
  if (options.configured !== false) await activate(options.duration === undefined ? 0 : options.duration, "deletion-policy");
  await store.createSession(session);
  if (!options.empty) await store.commit({ sessionId: session.id, fence: 1,
    usageEntries: Array.from({ length: options.usageCount ?? 1 }, (_, i) => ({ usageId: newUsageId(), turnId: newId("turn"), step: i + 1,
      provider: "provider", model: "model", usage: { ...emptyUsage(), inputTokens: 2, totalTokens: 2, costCNY: 1.25 }, createdAtMs: clock })),
  });
  await (options.ordinary === false ? store.commit.bind(store) : store.commitOrdinarySessionDelete.bind(store))({
    sessionId: session.id, fence: 2, lifecycle: { type: "tombstone", tenantId: session.tenantId,
      userId: session.userId, atMs: clock, purgeAfterMs: null, deletionGeneration: 1 },
    events: [{ type: "session/deleted", sessionId: session.id, emittedAtMs: clock, deletionGeneration: 1 }],
  });
  await store.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id);
  const owner = { tenantId: session.tenantId, userId: session.userId, sessionId: session.id, deletionGeneration: 1 };
  const reconciled = await store.reconcileSessionUsage({ ...owner, nowMs: clock });
  const input = { ...owner, expectedChecksum: reconciled.checksum, enabled: true as const };
  return { store, session, input, activate, setClock: (v: number) => { clock = v; },
    advance: (v: number) => { clock += v; }, now: () => clock };
}

describe("ordinary session usage retention atomic MemoryStore", () => {
  it.each(["reconciliation", "receipt"] as const)("rolls back every publication projection when %s publication throws", async (boundary) => {
    const f = await fixture(); f.advance(31 * DAY);
    const previousLedger = f.store.usageLedger;
    const before = structuredClone([...f.store.usageReconciliations]);
    const tombstone = f.store.deleted.get(f.session.id)!;
    const previousTombstone = structuredClone(tombstone);
    if (boundary === "reconciliation") {
      class FailOnceMap<K, V> extends Map<K, V> {
        private armed = false;
        arm() { this.armed = true; }
        override set(key: K, value: V): this { super.set(key, value); if (this.armed) { this.armed = false; throw new Error("injected publication failure"); } return this; }
      }
      const map = new FailOnceMap(f.store.usageReconciliations); map.arm(); f.store.usageReconciliations = map;
    } else {
      let armed = true;
      f.store.deleted.set(f.session.id, new Proxy(tombstone, { set(target, key, value) {
        const result = Reflect.set(target, key, value);
        if (armed && key === "ordinaryUsageRetentionReceiptSha256") { armed = false; throw new Error("injected publication failure"); }
        return result;
      } }));
    }
    await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(/injected publication failure/);
    expect(f.store.usageLedger).toBe(previousLedger);
    expect([...f.store.usageReconciliations]).toEqual(before);
    expect(f.store.deleted.get(f.session.id)).toEqual(previousTombstone);
    expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).not.toBeNull();
    expect(f.store.usageLedger).toHaveLength(0);
  });
  it("fails closed at the explicit per-session receipt budget without truncating billing proof", async () => {
    const f = await fixture({ usageCount: 10_001 }); f.advance(31 * DAY);
    await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(/capacity/);
    expect(f.store.usageLedger).toHaveLength(10_001);
    expect(f.store.billingUsageFacts.size).toBe(10_001);
    expect(f.store.deleted.get(f.session.id)?.ordinaryUsageRetentionReceipt).toBeUndefined();
    expect([...f.store.usageReconciliations.values()][0]?.status).toBe("verified");
  });
  it("requires the sealed 30-day boundary, keeps billing, and serializes exact replay", async () => {
    const f = await fixture();
    const original = structuredClone([...f.store.billingUsageFacts]);
    const floor = f.store.deleted.get(f.session.id)!.ordinaryDeleteGrace!.graceFloorDbMs!;
    f.setClock(floor - 1);
    expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).toBeNull();
    expect(f.store.usageLedger).toHaveLength(1);
    f.setClock(floor);
    const [first, replay] = await Promise.all([f.store.executeOrdinarySessionUsageRetention(f.input), f.store.executeOrdinarySessionUsageRetention(f.input)]);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ executedAtDbMs: floor, deadlineDbMs: floor,
      allDomainsComplete: false, contentPurgeExecuted: false });
    expect(f.store.usageLedger).toHaveLength(0);
    expect([...f.store.billingUsageFacts]).toEqual(original);
    expect(f.store.sessions.has(f.session.id)).toBe(true);
    expect(f.store.events.get(f.session.id)).toHaveLength(2);
    expect((await f.store.getLifecycleOutbox("session.purge", f.session.id, 1))?.availableAtMs).toBeUndefined();
    expect(await f.store.listOrdinarySessionUsageRetentionCandidates({ limit: 25 })).toEqual([]);
  });

  it("supports an explicit zero-fact receipt but not anonymized-without-receipt inference", async () => {
    const f = await fixture({ empty: true });
    f.advance(31 * DAY);
    expect((await f.store.executeOrdinarySessionUsageRetention(f.input))?.facts).toEqual([]);
    expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).not.toBeNull();
    const other = await fixture({ empty: true });
    other.advance(31 * DAY);
    await other.store.anonymizeSessionUsage({ ...other.input, nowMs: other.now() });
    await expect(other.store.executeOrdinarySessionUsageRetention(other.input)).rejects.toThrow(/no execution receipt/);
  });

  it.each([90 * DAY, null])("honors deletion-time %s retention rather than a later shorter policy", async (duration) => {
    const f = await fixture({ duration });
    f.advance(31 * DAY);
    await f.activate(0);
    expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).toBeNull();
    if (duration !== null) {
      f.advance(60 * DAY);
      expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).not.toBeNull();
    }
  });

  it("extends expiry under current longer policy and rejects current NULL", async () => {
    const f = await fixture(); f.advance(31 * DAY); await f.activate(90 * DAY);
    expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).toBeNull();
    f.advance(60 * DAY); await f.activate(null);
    expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).toBeNull();
    expect(await f.store.listOrdinarySessionUsageRetentionCandidates({ limit: 25 })).toEqual([]);
  });

  it.each([{ configured: false }, { ordinary: false }])("never retroactively binds old/unconfigured deletion %j", async (options) => {
    const f = await fixture(options); f.advance(31 * DAY); await f.activate(0);
    expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).toBeNull();
    expect(await f.store.listOrdinarySessionUsageRetentionCandidates({ limit: 25 })).toEqual([]);
  });

  it.each(["tenant", "user"] as const)("rechecks a %s hold installed after scanning", async (kind) => {
    const f = await fixture(); f.advance(31 * DAY);
    expect(await f.store.listOrdinarySessionUsageRetentionCandidates({ limit: 25 })).toHaveLength(1);
    await f.store.setLegalHold({ tenantId: f.session.tenantId, subjectKind: kind,
      subjectId: kind === "tenant" ? f.session.tenantId : f.session.userId,
      holdId: `hold_${randomUUID()}`, reasonCode: "litigation", expectedControlGeneration: 0,
      actorKeyId: "admin", atMs: f.now() });
    expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).toBeNull();
    expect(f.store.usageLedger).toHaveLength(1);
  });

  it("new hold/erasure does not revoke a committed non-expanding replay", async () => {
    const f = await fixture(); f.advance(31 * DAY);
    const receipt = await f.store.executeOrdinarySessionUsageRetention(f.input);
    await f.store.setLegalHold({ tenantId: f.session.tenantId, subjectKind: "user", subjectId: f.session.userId,
      holdId: `hold_${randomUUID()}`, reasonCode: "litigation", expectedControlGeneration: 0,
      actorKeyId: "admin", atMs: f.now() });
    await f.store.requestUserErasure({ requestId: newErasureRequestId(), tenantId: f.session.tenantId,
      userId: f.session.userId, requestedByKeyId: "admin", idempotencyKey: randomUUID(),
      requestHash: userErasureRequestHash(f.session.tenantId, f.session.userId), atMs: f.now() });
    f.setClock(1);
    expect(await f.store.executeOrdinarySessionUsageRetention(f.input)).toEqual(receipt);
  });

  it.each(["tenant", "user"] as const)("rejects %s erasure admitted after scanning", async (kind) => {
    const f = await fixture(); f.advance(31 * DAY);
    expect(await f.store.listOrdinarySessionUsageRetentionCandidates({ limit: 25 })).toHaveLength(1);
    if (kind === "tenant") await f.store.requestTenantErasure({ requestId: newErasureRequestId(), tenantId: f.session.tenantId,
      requestedByKeyId: "admin", idempotencyKey: randomUUID(), requestHash: tenantErasureRequestHash(f.session.tenantId), atMs: f.now() });
    else await f.store.requestUserErasure({ requestId: newErasureRequestId(), tenantId: f.session.tenantId, userId: f.session.userId,
      requestedByKeyId: "admin", idempotencyKey: randomUUID(), requestHash: userErasureRequestHash(f.session.tenantId, f.session.userId), atMs: f.now() });
    await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow();
    expect(f.store.usageLedger).toHaveLength(1);
    expect(f.store.deleted.get(f.session.id)?.ordinaryUsageRetentionReceipt).toBeUndefined();
  });

  it("fails closed on restore/runtime footprint and backward clock without partial deletion", async () => {
    const f = await fixture(); f.advance(31 * DAY);
    f.store.tenantRestoreFences.set(f.session.tenantId, {} as never);
    await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow();
    f.store.tenantRestoreFences.delete(f.session.tenantId);
    f.setClock(1);
    await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(/clock regressed/);
    expect(f.store.usageLedger).toHaveLength(1);
  });

  it("rechecks a real restore journal runtime activation after scanning", async () => {
    const f = await fixture(); f.advance(31 * DAY);
    expect(await f.store.listOrdinarySessionUsageRetentionCandidates({ limit: 25 })).toHaveLength(1);
    const target = { targetOrdinal: 0, targetSha256: "a".repeat(64), failureDomainSha256: "b".repeat(64),
      adapterProtocol: "memory-restore-journal-v1", journalNamespaceSha256: "c".repeat(64) };
    await f.store.activateTenantRestoreJournalControl({ adapterProtocol: target.adapterProtocol,
      journalNamespaceSha256: target.journalNamespaceSha256, logicalDatabaseNamespaceSha256: "d".repeat(64),
      runtimeEpochSha256: "e".repeat(64), targets: [target], observedHeads: [{ ...target,
        logicalDatabaseNamespaceSha256: "d".repeat(64), sealedRemoteSequence: 0,
        sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256 }] });
    await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(/erasure\/restore gate/);
    expect(f.store.usageLedger).toHaveLength(1);
  });

  it("enforces owner/generation/checksum and independently proves retained billing on replay", async () => {
    const f = await fixture(); f.advance(31 * DAY);
    for (const altered of [{ tenantId: "other" }, { userId: "other" }, { deletionGeneration: 2 }, { expectedChecksum: "f".repeat(64) }]) {
      await expect(f.store.executeOrdinarySessionUsageRetention({ ...f.input, ...altered })).rejects.toThrow();
    }
    const fact = [...f.store.billingUsageFacts.values()][0]!;
    f.store.billingUsageFacts.delete(fact.usageId);
    await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow();
    expect(f.store.usageLedger).toHaveLength(1);
    f.store.billingUsageFacts.set(fact.usageId, fact);
    await f.store.executeOrdinarySessionUsageRetention(f.input);
    f.store.billingUsageFacts.delete(fact.usageId);
    await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(/billing fact missing/);
  });

  it("rejects partial source and contradictory self-hashed receipt/policy/time", async () => {
    const f = await fixture(); f.advance(31 * DAY);
    const deleted = f.store.deleted.get(f.session.id)!;
    const source = deleted.ordinaryUsageRetentionSource!;
    delete deleted.ordinaryUsageRetentionSource;
    await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(/partial source/);
    deleted.ordinaryUsageRetentionSource = source;
    await f.store.executeOrdinarySessionUsageRetention(f.input);
    const receipt = deleted.ordinaryUsageRetentionReceipt!;
    receipt.deletionPolicySha256 = "f".repeat(64);
    deleted.ordinaryUsageRetentionReceiptSha256 = ordinaryUsageRetentionReceiptSha256(receipt);
    await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(/policy\/source replay changed/);
    receipt.deletionPolicySha256 = source.policySha256!;
    deleted.ordinaryUsageRetentionReceiptSha256 = ordinaryUsageRetentionReceiptSha256(receipt);
    const reconciliation = [...f.store.usageReconciliations.values()][0]!;
    reconciliation.anonymizedAtMs! += 1;
    await expect(f.store.executeOrdinarySessionUsageRetention(f.input)).rejects.toThrow(/exact replay changed/);
  });

  it("does not starve later candidates behind damaged proof", async () => {
    const f = await fixture({ sessionId: "sess_00000000-0000-4000-8000-000000000001" });
    const neighbor = await fixture({ store: f.store, nowMs: f.now(), sessionId: "sess_ffffffff-ffff-4fff-8fff-ffffffffffff" });
    f.advance(31 * DAY);
    f.store.deleted.get(f.session.id)!.ordinaryUsageRetentionSourceSha256 = "f".repeat(64);
    const candidates = await f.store.listOrdinarySessionUsageRetentionCandidates({ limit: 1 });
    expect(candidates).toHaveLength(1);
    await expect(f.store.executeOrdinarySessionUsageRetention({ ...candidates[0]!, expectedChecksum: f.input.expectedChecksum, enabled: true })).rejects.toThrow();
    const later = await f.store.listOrdinarySessionUsageRetentionCandidates({ afterSessionId: candidates[0]!.sessionId, limit: 1 });
    expect(later.map((v) => v.sessionId)).toEqual([neighbor.session.id]);
    expect(await f.store.executeOrdinarySessionUsageRetention(neighbor.input)).not.toBeNull();
    expect(ORDINARY_SESSION_DELETE_GRACE_MS).toBe(30 * DAY);
  });
});
