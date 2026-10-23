import { acquireFixtureSessionAuthority } from "../../store/test/fixtures/session-authority.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStructuredTelemetry, emptyUsage, type Item, type StructuredTelemetryRecord, type Turn } from "@agent-service/protocol";
import { EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256, MemorySessionStore, S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA, newUsageId, s3TenantTelemetryTargetIdentity, tenantTelemetryWriteAdapterResult,
  type TenantTelemetryWriteAdapter, type TenantTelemetryWriteAdapterInput, type TenantTelemetryWriteClaim,
  type TenantTelemetryPersistedProviderCaptureProof } from "@agent-service/store";
import { createPersistedProviderFailureCapture, newId, TenantTelemetryWriterWorker } from "../src/index.js";

const key = new Uint8Array(32).fill(43);
const D = (character: string) => character.repeat(64);
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const closed = await Promise.allSettled(closers.splice(0).map((close) => close()));
  const failure = closed.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
});

/** Real atomic Memory source/store. The external adapter is an explicit process-only unit fake;
 * these tests prove app boundary sequencing, never real S3 durability or configured fleet reachability. */
async function fixture(failAt?: string, responseLoss?: "sink" | "database", mixedQueue = false) {
  let now = 1000;
  const store = new MemorySessionStore({ now: () => now }, { tenantTelemetryRefKey: key, tenantTelemetryPersistedProviderCaptureLocalOnly: true });
  let ownedWriter: Awaited<ReturnType<typeof acquireFixtureSessionAuthority>> | undefined;
  let ownedWorker: TenantTelemetryWriterWorker | undefined;
  // Register the actual store before the first await; late preparation failures retain its owner.
  closers.push(async () => {
    let failed = false, first: unknown;
    for (const close of [() => ownedWorker?.stop(), () => ownedWriter?.release(), () => store.close()]) {
      try { await close(); } catch (reason) { if (!failed) { failed = true; first = reason; } }
    }
    if (failed) throw first;
  });
  const restoreTarget = { targetOrdinal: 0, targetSha256: D("1"), failureDomainSha256: D("2"), adapterProtocol: "memory-restore-journal-v1", journalNamespaceSha256: D("3") };
  await store.activateTenantRestoreJournalControl({ adapterProtocol: restoreTarget.adapterProtocol, journalNamespaceSha256: restoreTarget.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: D("4"), runtimeEpochSha256: D("5"), targets: [restoreTarget],
    observedHeads: [{ ...restoreTarget, logicalDatabaseNamespaceSha256: D("4"), sealedRemoteSequence: 0, sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256 }] });
  await store.activateTenantTelemetryLifecycle({ expectedControlGeneration: 0, targets: (["logs", "traces"] as const).map((domain) => ({ domain,
    ...s3TenantTelemetryTargetIdentity({ namespaceId: "unit-capture", failureDomainId: "unit-fake", bucket: "unit-capture", prefix: "capture", region: "us-east-1", endpoint: null, forcePathStyle: false, domain }),
  })) });
  const lifecycle = await store.getTenantTelemetryLifecycleControl();
  if (lifecycle.state !== "active") throw new Error("unit lifecycle not active");
  const tenantId = "unit-capture-worker", userId = "unit-user";
  const legacyOperations: string[] = [];
  if (mixedQueue) {
    await store.createApiKey(tenantId, "unit-key", "unit-hash");
    for (const [ordinal, domain] of (["logs", "traces"] as const).entries()) {
      let record: Readonly<StructuredTelemetryRecord> | undefined;
      const telemetry = createStructuredTelemetry({ component: "runner", opaqueRefKey: key, now: () => now,
        sink: { write(value) { record = value; } } });
      telemetry.info("runner.runtime.info", { subjectRef: telemetry.opaqueRef("tenant", tenantId), ownerRef: telemetry.opaqueRef("tenant", tenantId) });
      if (!record) throw new Error("legacy fixture record missing");
      // The inventory's source high-water is a logical bound, not an external-write timestamp.
      // Using a later logical bound gives an immutable ordering with v2 ahead at LIMIT 1;
      // no queue fields, leases, receipts or store methods are replaced by this test.
      const job = await store.enqueueTenantTelemetryArtifact({ tenantId, expectedControlGeneration: 1,
        domain, artifactIdSha256: D(String(ordinal + 7)), artifactGeneration: 1,
        ownerKind: "tenant", ownerId: tenantId, ownerUserId: null,
        sourceSchema: "structured-log-batch-v1", sourceGeneration: 1, sourceHighWaterDbMs: 2_000 + ordinal,
        payload: { schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA, domain, records: [record] } });
      legacyOperations.push(job.writeOperationSha256);
    }
  }
  const logs = (await store.listTenantTelemetryLifecycleTargets()).find((target) => target.domain === "logs")!;
  await store.withTenantTelemetryCaptureOperatorFence((fence) => store.activateTenantTelemetryPersistedProviderCapture({ expectedControlGeneration: 0,
    lifecycleControlEvidenceSha256: lifecycle.activationEvidenceSha256, logsTargetSha256: logs.targetSha256, logsTargetReceiptSha256: logs.receiptSha256,
    configuredFleetRootSha256: D("6"), fleetStoppedAck: "fleet-stopped-v1", legacyWritersDrainedAck: "legacy-writers-drained-v1", producerReadyAck: "provider-step-error-v2-ready-v1", localOnlyAck: "local-only-v1",
  }, fence), { timeoutMs: 1000 });
  now = 1100;
  if (!mixedQueue) await store.createApiKey(tenantId, "unit-key", "unit-hash");
  const session = { id: newId("sess"), tenantId, userId, agentId: newId("agt"), agentVersion: 1, status: { type: "idle" as const }, lastSeq: 0,
    contextEpoch: "unit", fenceToken: 0, usage: emptyUsage(), autoApprovedTools: [], createdAtMs: now, updatedAtMs: now, metadata: {} };
  await store.createSession(session);
  const writer = await acquireFixtureSessionAuthority(store, session, 0); ownedWriter = writer;
  const turn: Turn = { id: newId("turn"), sessionId: session.id, status: "inProgress", seqStart: 2, steps: 0, toolCalls: 0, usage: emptyUsage(), startedAtMs: now, metadata: {} };
  await store.commit(writer.admit({ sessionId: session.id, fence: 1, turn, events: [{ type: "turn/started", sessionId: session.id, emittedAtMs: now, turn }], sessionPatch: { status: { type: "active", turnId: turn.id, activeFlags: [] } } }));
  const item: Item = { id: newId("item"), sessionId: session.id, turnId: turn.id, seq: 0, step: 1, type: "agentMessage", status: "failed", createdAtMs: now, completedAtMs: now, text: "private partial response", phase: "finalAnswer" };
  const stepUsage = { ...emptyUsage(), inputTokens: 2, outputTokens: 1, totalTokens: 3 };
  const product = createPersistedProviderFailureCapture({ store, opaqueRefKey: key, requireFreshFleet: async (expected) => expected });
  const receipt = await product.commit(writer.admit({ sessionId: session.id, fence: 1, turn: { ...turn, usage: stepUsage }, items: [item],
    events: [{ type: "item/completed", sessionId: session.id, emittedAtMs: now, item }, { type: "usage/updated", sessionId: session.id, emittedAtMs: now, turnId: turn.id, step: 1,
      stepUsage, turnUsage: stepUsage, sessionUsage: stepUsage, runtime: { provider: "unit", model: "unit" } }],
    usageEntries: [{ usageId: newUsageId(), turnId: turn.id, step: 1, provider: "unit", model: "unit", usage: stepUsage, createdAtMs: now }], sessionPatch: { usage: stepUsage },
  }), { tenantId, userId, turnId: turn.id, itemId: item.id, stepIndex: 1, failureKind: "provider_step_error" });
  const operation = receipt.failureCommitReceipt.writeOperationSha256;
  if (mixedQueue) now = 3_000;
  const calls: string[] = [];
  const present = new Map<string, TenantTelemetryWriteAdapterInput>();
  const adapter: TenantTelemetryWriteAdapter = {
    adapterProtocol: S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    async inspectWrite(input) { calls.push("inspect"); return present.has(input.writeOperationSha256)
      ? { status: "exact", result: tenantTelemetryWriteAdapterResult(this.adapterProtocol, input, "already_present", true) } : { status: "absent" }; },
    async createWrite(input) { calls.push("external-create"); present.set(input.writeOperationSha256, structuredClone(input));
      if (responseLoss === "sink") throw new Error("unit response lost after create");
      return tenantTelemetryWriteAdapterResult(this.adapterProtocol, input, "written", false); },
    async close() {},
  };
  const reserveOriginal = store.reserveTenantTelemetryExternalMutation.bind(store);
  const reserve = vi.spyOn(store, "reserveTenantTelemetryExternalMutation");
  const complete = vi.spyOn(store, "completeTenantTelemetryWrite");
  const claimOriginal = store.claimTenantTelemetryWriteJobs.bind(store);
  const claim = vi.spyOn(store, "claimTenantTelemetryWriteJobs");
  let gateFailure = failAt;
  if (responseLoss === "database") {
    const original = store.completeTenantTelemetryWrite.bind(store);
    complete.mockImplementationOnce(async (...args) => { await original(...args); throw new Error("unit response lost after ACK"); });
  }
  const worker = new TenantTelemetryWriterWorker({ store, adapter, logger: { warn() {} }, persistedProviderCapture: {
    store,
    async requireFreshFleet(expected, boundary) { calls.push(`fresh-${boundary}`); if (boundary === gateFailure) throw new Error("unit configured target offline"); return expected; },
  } }, { leaseMs: 1000, batchSize: 1, retryBaseMs: 10, retryMaxMs: 100 });
  ownedWorker = worker;
  return { store, worker, adapter, calls, operation, tenantId, present, reserve, reserveOriginal, complete, claim, claimOriginal, legacyOperations,
    setGateFailure(boundary?: string) { gateFailure = boundary; },
    advanceTime(delta: number) { now += delta; },
    async deleteOwner() {
      now += 1;
      const failedTurn: Turn = { ...turn, steps: 1, usage: stepUsage, status: "failed", completedAtMs: now, stopReason: "error" };
      await store.commit(writer.admit({ sessionId: session.id, fence: 1, expectedLastSeq: 4, turn: failedTurn,
        events: [{ type: "error", sessionId: session.id, emittedAtMs: now, code: "provider_error", message: "Provider request failed." },
          { type: "turn/completed", sessionId: session.id, emittedAtMs: now, turn: failedTurn, stopReason: "error" },
          { type: "session/status/changed", sessionId: session.id, emittedAtMs: now, status: { type: "idle" } }],
        sessionPatch: { status: { type: "idle" } } }));
      await store.commitOrdinarySessionDelete(writer.admit({ sessionId: session.id, fence: 1, expectedLastSeq: 7,
        lifecycle: { type: "tombstone", tenantId, userId, atMs: now, purgeAfterMs: null, deletionGeneration: 1 },
        events: [{ type: "session/deleted", sessionId: session.id, emittedAtMs: now, deletionGeneration: 1 }] }));
      await store.sealOrdinarySessionDeleteGrace(tenantId, userId, session.id);
    } };
}

/** Only worker control-flow is under test here: the returned claim's recovery
 * projection is injected onto an actual PRIMARY source/claim. This is not a
 * restored epoch, a durable recovery permit, a real S3 ACK or fleet proof.
 * Real restore authorization is independently covered by the store/vertical
 * suites. Keeping that distinction makes a branch test useful without letting
 * a fake permit stand in for source validation. */
async function recoveryBranchFixture(
  recoveryMode: NonNullable<TenantTelemetryWriteClaim["captureRecovery"]>["recoveryMode"],
  remotePresent = false,
  responseLoss?: "sink" | "database",
) {
  const h = await fixture(undefined, responseLoss);
  const proof = await h.store.getTenantTelemetryPersistedProviderCaptureBinding();
  if (!proof) throw new Error("worker branch fixture has no active primary binding");
  let originalReservation: TenantTelemetryWriteClaim["reservation"];
  if (recoveryMode !== "resume_queued") {
    const [seed] = await h.claimOriginal({ limit: 1, leaseMs: 1_000,
      claimToken: "worker-recovery-seed-claim-token", adapterProtocol: h.adapter.adapterProtocol,
      captureMode: "include_v2", freshProof: proof });
    if (!seed) throw new Error("worker branch fixture has no seed claim");
    const seedAuth = { tenantId: seed.tenantId, writeOperationSha256: seed.writeOperationSha256,
      claimAttempt: seed.claimAttempt, claimToken: seed.claimToken };
    const reservation = await h.reserveOriginal(seedAuth, h.adapter.adapterProtocol, proof);
    if (!reservation) throw new Error("worker branch fixture has no reservation");
    originalReservation = structuredClone(reservation);
    if (remotePresent) h.present.set(seed.writeOperationSha256, {
      writeOperationSha256: seed.writeOperationSha256, target: seed.target,
      inventory: seed.inventory, payload: seed.payload,
    });
    expect(await h.store.retryTenantTelemetryWrite(seedAuth, { delayMs: 10, errorCode: "temporary_failure" })).toBe(true);
    h.advanceTime(11);
  }
  h.claim.mockImplementationOnce(async (options) => (await h.claimOriginal(options)).map((claim) => ({
    ...claim,
    captureRecovery: { permitReceiptSha256: D("c"), recoveryMode,
      claimLeaseCeilingMs: claim.leaseUntilMs + 5_000 },
  })));
  h.calls.length = 0;
  return { ...h, originalReservation };
}

describe("persisted provider source writer fresh boundaries", () => {
  it("retries an absent ACK-only recovery object without reserving, creating or acknowledging", async () => {
    const h = await recoveryBranchFixture("reserved_ack_only");
    const retry = vi.spyOn(h.store, "retryTenantTelemetryWrite");
    expect(await h.worker.processOnce()).toBe(0);
    expect(h.calls).toEqual(["fresh-claim", "inspect"]);
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.complete).not.toHaveBeenCalled();
    expect(h.present.size).toBe(0); expect(retry).toHaveBeenCalledOnce();
    const queued = await h.store.getTenantTelemetryWriteJob(h.tenantId, h.operation);
    expect(queued).toMatchObject({ phase: "queued", attempts: 2, reservation: h.originalReservation });
    expect(queued?.claimToken).toBeUndefined();
  });

  it.each([undefined, "database"] as const)("acknowledges an exact ACK-only recovery object without another create (loss=%s)", async (loss) => {
    const h = await recoveryBranchFixture("reserved_ack_only", true, loss);
    expect(await h.worker.processOnce()).toBe(1);
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.present.size).toBe(1);
    expect(h.calls.filter((call) => call === "external-create")).toHaveLength(0);
    expect(h.calls.filter((call) => call === "fresh-ack")).toHaveLength(loss === "database" ? 2 : 1);
    const ack = await h.store.getTenantTelemetryWriteAck(h.tenantId, h.operation);
    expect(ack?.reservationReceiptSha256).toBe(h.originalReservation?.receiptSha256);
  });

  it("resumes a reserved-before-create object using the existing immutable reservation", async () => {
    const h = await recoveryBranchFixture("resume_reserved");
    expect(await h.worker.processOnce()).toBe(1);
    expect(h.calls).toEqual(["fresh-claim", "inspect", "fresh-create", "external-create", "fresh-ack"]);
    expect(h.reserve).not.toHaveBeenCalled();
    expect((await h.store.getTenantTelemetryWriteJob(h.tenantId, h.operation))?.reservation).toEqual(h.originalReservation);
    expect((await h.store.getTenantTelemetryWriteAck(h.tenantId, h.operation))?.reservationReceiptSha256)
      .toBe(h.originalReservation?.receiptSha256);
  });

  it("keeps a recovered queued claim's branch metadata after first reserve and continues create/ACK", async () => {
    const h = await recoveryBranchFixture("resume_queued");
    expect(await h.worker.processOnce()).toBe(1);
    expect(h.calls).toEqual(["fresh-claim", "inspect", "fresh-reserve", "inspect", "fresh-create", "external-create", "fresh-ack"]);
    expect(h.reserve).toHaveBeenCalledOnce(); expect(h.complete).toHaveBeenCalledOnce();
    expect(await h.store.getTenantTelemetryWriteAck(h.tenantId, h.operation)).not.toBeNull();
  });

  it.each(["create", "ack"] as const)("rechecks the %s fleet boundary while resuming an existing reservation", async (boundary) => {
    const h = await recoveryBranchFixture("resume_reserved");
    h.setGateFailure(boundary);
    expect(await h.worker.processOnce()).toBe(0);
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.complete).not.toHaveBeenCalled();
    expect(h.calls).toContain(`fresh-${boundary}`);
    expect(h.present.size).toBe(boundary === "ack" ? 1 : 0);
    expect((await h.store.getTenantTelemetryWriteJob(h.tenantId, h.operation))?.reservation).toEqual(h.originalReservation);
  });

  it("requires separate observations at claim, reserve, create and ACK, passing the current tuple to each store transaction", async () => {
    const h = await fixture();
    expect(await h.worker.processOnce()).toBe(1);
    expect(h.calls).toEqual(["fresh-claim", "inspect", "fresh-reserve", "inspect", "fresh-create", "external-create", "fresh-ack"]);
    expect(h.claim.mock.calls[0]?.[0]).toMatchObject({ captureMode: "include_v2", freshProof: { runtimeEpochSha256: D("5") } });
    expect(h.reserve.mock.calls[0]?.[2]).toMatchObject({ runtimeEpochSha256: D("5") });
    expect(h.complete.mock.calls[0]?.[2]).toMatchObject({ runtimeEpochSha256: D("5") });
    expect(await h.store.verifyPersistedProviderStepFailureWrite(h.tenantId, h.operation, h.complete.mock.calls[0]![2] as TenantTelemetryPersistedProviderCaptureProof)).toMatchObject({ status: "source_verified_written", sourceCount: 1, executionReady: false, allDomainsComplete: false });
  });

  it.each(["claim", "reserve", "create", "ack"])("does not use an earlier success after the %s fleet boundary fails", async (boundary) => {
    const h = await fixture(boundary);
    expect(await h.worker.processOnce()).toBe(0);
    expect(h.calls).toContain(`fresh-${boundary}`);
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.present.size).toBe(boundary === "ack" ? 1 : 0);
    expect(await h.store.getTenantTelemetryWriteAck(h.tenantId, h.operation)).toBeNull();
  });

  it.each(["sink", "database"] as const)("rechecks fresh ACK during exact %s response-loss closure without another external create", async (responseLoss) => {
    const h = await fixture(undefined, responseLoss);
    expect(await h.worker.processOnce()).toBe(1);
    expect(h.calls.filter((call) => call === "external-create")).toHaveLength(1);
    expect(h.calls.filter((call) => call === "fresh-ack")).toHaveLength(responseLoss === "database" ? 2 : 1);
    expect(await h.store.getTenantTelemetryWriteAck(h.tenantId, h.operation)).not.toBeNull();
  });

  it("never falls back to the legacy worker path when v2 fresh-gate assembly is missing", async () => {
    const h = await fixture();
    const withoutCapture = new TenantTelemetryWriterWorker({ store: h.store, adapter: h.adapter, logger: { warn() {} } }, { leaseMs: 1000, batchSize: 1 });
    closers.push(() => withoutCapture.stop());
    expect(await withoutCapture.processOnce()).toBe(0);
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.present.size).toBe(0);
    expect(await h.store.getTenantTelemetryWriteJob(h.tenantId, h.operation)).toMatchObject({ phase: "queued", attempts: 0 });
    expect(h.claim.mock.calls[0]?.[0]).toMatchObject({ captureMode: "legacy_only" });
  });

  it.each(["failed", "missing", "inactive"] as const)("drains pre-cutover v1 logs and traces at LIMIT 1 with a %s v2 gate, without leasing the earlier v2 source", async (gateState) => {
    const h = await fixture("claim", undefined, true);
    const queuedV2 = await h.store.getTenantTelemetryWriteJob(h.tenantId, h.operation);
    if (!queuedV2) throw new Error("v2 queue fixture missing");
    for (const operation of h.legacyOperations) {
      const legacy = await h.store.getTenantTelemetryWriteJob(h.tenantId, operation);
      expect(legacy?.createdAtMs).toBeGreaterThan(queuedV2.createdAtMs);
    }
    let instance = h.worker;
    if (gateState !== "failed") {
      const withoutGate = new TenantTelemetryWriterWorker({ store: h.store, adapter: h.adapter, logger: { warn() {} },
        ...(gateState === "inactive" ? { persistedProviderCapture: {
          store: { getTenantTelemetryPersistedProviderCaptureBinding: async () => null,
            verifyPersistedProviderStepFailureWrite: h.store.verifyPersistedProviderStepFailureWrite.bind(h.store) },
          requireFreshFleet: async () => { throw new Error("inactive binding must not contact fleet"); },
        } } : {}),
      }, { leaseMs: 1000, batchSize: 1 });
      closers.push(() => withoutGate.stop());
      instance = withoutGate;
    }
    expect(await instance.processOnce()).toBe(1);
    expect(await instance.processOnce()).toBe(1);
    expect(await instance.processOnce()).toBe(0);
    for (const operation of h.legacyOperations) {
      expect(await h.store.getTenantTelemetryWriteAck(h.tenantId, operation)).not.toBeNull();
      expect(h.present.has(operation)).toBe(true);
    }
    expect(await h.store.getTenantTelemetryWriteJob(h.tenantId, h.operation)).toEqual(queuedV2);
    expect(await h.store.getTenantTelemetryWriteAck(h.tenantId, h.operation)).toBeNull();
    expect(h.present.has(h.operation)).toBe(false);
    expect(h.claim.mock.calls.map(([options]) => options)).toEqual(expect.arrayContaining([
      expect.objectContaining({ captureMode: "legacy_only", limit: 1 }),
    ]));
    expect(h.claim.mock.calls.every(([options]) => options.captureMode === "legacy_only" && options.freshProof === undefined)).toBe(true);
    expect(h.calls.some((call) => ["fresh-reserve", "fresh-create", "fresh-ack"].includes(call))).toBe(false);
    h.calls.length = 0;
    h.setGateFailure();
    expect(await h.worker.processOnce()).toBe(1);
    expect(h.calls).toEqual(["fresh-claim", "inspect", "fresh-reserve", "inspect", "fresh-create", "external-create", "fresh-ack"]);
    expect(await h.store.getTenantTelemetryWriteJob(h.tenantId, h.operation)).toMatchObject({ phase: "written", attempts: 1 });
    expect(h.present.has(h.operation)).toBe(true);
  });

  it("blocks a lost canonical source instead of treating a fleet ACK as source authority", async () => {
    const h = await fixture();
    vi.spyOn(h.store, "verifyPersistedProviderStepFailureWrite").mockResolvedValueOnce({ status: "not_found", sourceCount: 0, failureCommitReceiptSha256: null,
      sourceBindingReceiptSha256: null, writeOperationSha256: null, membershipSha256: null, writeAckReceiptSha256: null, inventoryReceiptSha256: null, executionReady: false, allDomainsComplete: false });
    expect(await h.worker.processOnce()).toBe(0);
    expect(h.calls).toEqual(["fresh-claim", "inspect", "fresh-reserve"]);
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.present.size).toBe(0);
    expect(await h.store.getTenantTelemetryWriteJob(h.tenantId, h.operation)).toMatchObject({ phase: "blocked", blockedReasonCode: "integrity_conflict" });
  });

  it("does not create after reserve→DELETE, including an absent-object retry with the existing reservation", async () => {
    const h = await fixture();
    h.reserve.mockImplementationOnce(async (...args) => {
      const reservation = await h.reserveOriginal(...args);
      await h.deleteOwner();
      // The original lease is still live here: denial is the deleted canonical owner, not an
      // invalid/cleared claim after worker retry. An existing reservation cannot skip this gate.
      await expect(h.reserveOriginal(...args)).resolves.toBeNull();
      return reservation;
    });
    expect(await h.worker.processOnce()).toBe(0);
    expect(h.calls).toContain("fresh-create");
    expect(h.present.size).toBe(0);
    expect(h.complete).not.toHaveBeenCalled();
    const job = await h.store.getTenantTelemetryWriteJob(h.tenantId, h.operation);
    expect(job).toMatchObject({ phase: "queued", attempts: 1, reservation: { writeOperationSha256: h.operation } });
    h.advanceTime(11);
    expect(await h.worker.processOnce()).toBe(0);
    expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(h.present.size).toBe(0);
    expect(h.calls.filter((call) => call === "fresh-create")).toHaveLength(2);
    expect(await h.store.getTenantTelemetryWriteAck(h.tenantId, h.operation)).toBeNull();
  });

  it.each([undefined, "sink"] as const)("allows fresh exact ACK after a real external create then DELETE (response loss=%s), not another create", async (responseLoss) => {
    const h = await fixture(undefined, responseLoss);
    const create = h.adapter.createWrite.bind(h.adapter);
    vi.spyOn(h.adapter, "createWrite").mockImplementationOnce(async (input) => {
      try { return await create(input); }
      finally { await h.deleteOwner(); }
    });
    expect(await h.worker.processOnce()).toBe(1);
    expect(h.present.size).toBe(1);
    expect(h.calls.filter((call) => call === "external-create")).toHaveLength(1);
    expect(h.calls).toContain("fresh-ack");
    expect(await h.store.getTenantTelemetryWriteAck(h.tenantId, h.operation)).not.toBeNull();
  });
});
