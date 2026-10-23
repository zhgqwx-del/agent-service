import { describe, expect, it, vi } from "vitest";
import {
  MemorySessionStore,
  newErasureRequestId,
  tenantErasureRequestHash,
  tenantTelemetryWriteAdapterResult,
} from "../src/index.js";
import { mkSession } from "./conformance.js";
import {
  activateCaptureFixture,
  captureRefKey,
  captureCurrentStepFixture as captureStepFixture,
} from "./persisted-provider-capture.fixture.js";
import { admitCaptureFixtureInput, currentCaptureMemorySnapshot } from "./fixtures/capture-current-authority.js";

function storeWithCaptureKey() {
  return new MemorySessionStore(
    { now: () => Date.now() },
    { tenantTelemetryRefKey: captureRefKey, tenantTelemetryPersistedProviderCaptureLocalOnly: true },
  );
}

function admissionInput(tenantId: string) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    requestedByKeyId: "retained-source-unit-admin",
    idempotencyKey: `retained-source-${newErasureRequestId()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: Date.now(),
  };
}

async function registerTenant(store: MemorySessionStore, tenantId: string) {
  // A session alone is not the canonical tenant registry used by tenant-erasure T1.
  await store.createApiKey(tenantId, `key-${tenantId}`, `hash-${tenantId}`);
}

async function publishWrittenCapture(store: MemorySessionStore, tenantId: string, userId: string) {
  await registerTenant(store, tenantId);
  const source = await captureStepFixture(store, { tenantId, userId });
  const committed = await store.commitPersistedProviderStepFailure(admitCaptureFixtureInput(source));
  const [claim] = await store.claimTenantTelemetryWriteJobs({
    limit: 1,
    leaseMs: 30_000,
    claimToken: `retained-source-write-${newErasureRequestId()}`,
    adapterProtocol: "telemetry-s3-object-v1",
    captureMode: "include_v2",
    freshProof: source.proof,
  });
  expect(claim?.writeOperationSha256).toBe(committed.failureCommitReceipt.writeOperationSha256);
  const authorization = {
    tenantId,
    writeOperationSha256: claim!.writeOperationSha256,
    claimAttempt: claim!.claimAttempt,
    claimToken: claim!.claimToken,
  };
  expect(await store.reserveTenantTelemetryExternalMutation(
    authorization, "telemetry-s3-object-v1", source.proof,
  )).not.toBeNull();
  const result = tenantTelemetryWriteAdapterResult(
    "telemetry-s3-object-v1",
    {
      writeOperationSha256: claim!.writeOperationSha256,
      target: claim!.target,
      inventory: claim!.inventory,
      payload: claim!.payload,
    },
    "already_present",
    true,
  );
  expect(await store.completeTenantTelemetryWrite(authorization, result, source.proof)).not.toBeNull();
  return { source, committed };
}

describe("0054 retained-source T1 Memory publication", () => {
  it("keeps inactive 0053 admission on the original subject-free family", async () => {
    const store = new MemorySessionStore();
    const tenantId = "retained-inactive-tenant";
    await registerTenant(store, tenantId);
    await store.createSession(mkSession(tenantId, "inactive-user"));
    const input = admissionInput(tenantId);
    const admitted = await store.requestTenantErasure(input);
    expect(admitted.requestId).toBe(input.requestId);
    expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, input.requestId)).toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceT1CohortEntries(tenantId, input.requestId)).toEqual([]);
    expect(await store.getTenantTelemetryLifecycleSubject(tenantId, input.requestId)).toBeNull();
    expect(await store.requestTenantErasure(input)).toEqual(admitted);
  });

  it("seals an eligible original-primary cohort from a genuine completed v2 source before tenant deletion", async () => {
    const store = storeWithCaptureKey();
    await activateCaptureFixture(store);
    const tenantId = "retained-new-tenant";
    const { source, committed } = await publishWrittenCapture(store, tenantId, "retained-user");
    const input = admissionInput(tenantId);
    const admitted = await store.requestTenantErasure(input);
    const receipt = await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, input.requestId);
    const entries = await store.getTenantTelemetryRetainedSourceT1CohortEntries(tenantId, input.requestId);
    const subject = await store.getTenantTelemetryLifecycleSubject(tenantId, input.requestId);
    expect(receipt).toMatchObject({
      requestId: input.requestId,
      tenantId,
      profile: { kind: "eligible-primary", legacyFailedItemCount: 0 },
      eligibility: "eligible_retained",
      entryCount: 1,
      writtenAckCount: 1,
      pendingCount: 0,
      reservedCount: 0,
      blockedCount: 0,
      unknownCount: 0,
      executionReady: false,
      externalAuthorityVerified: false,
      allDomainsComplete: false,
      contentPurgeExecuted: false,
    });
    expect(receipt?.tenantLifecycleSubjectEvidenceSha256).toBe(subject?.receiptSha256);
    expect(entries).toMatchObject([{
      state: "written_ack",
      writeOperationSha256: committed.failureCommitReceipt.writeOperationSha256,
      failureCommitReceiptSha256: committed.failureCommitReceipt.receiptSha256,
    }]);
    expect(entries[0]?.sourceIdentitySha256).not.toContain(source.session.id);
    expect(entries[0]?.sourceIdentitySha256).not.toContain(source.session.userId);
    expect(await store.requestTenantErasure(input)).toEqual(admitted);
    expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, input.requestId)).toEqual(receipt);
    expect(await store.getTenantTelemetryRetainedSourceT1CohortEntries(tenantId, input.requestId)).toEqual(entries);
  });

  it.each(["pending", "reserved"] as const)("freezes a %s v2 source as blocked even after an exact late ACK", async (state) => {
    const store = storeWithCaptureKey();
    await activateCaptureFixture(store);
    const tenantId = `retained-${state}-tenant`;
    await registerTenant(store, tenantId);
    const source = await captureStepFixture(store, { tenantId, userId: `${state}-user` });
    const committed = await store.commitPersistedProviderStepFailure(admitCaptureFixtureInput(source));
    let authorization: {
      tenantId: string;
      writeOperationSha256: string;
      claimAttempt: number;
      claimToken: string;
    } | null = null;
    let result: ReturnType<typeof tenantTelemetryWriteAdapterResult> | null = null;
    if (state === "reserved") {
      const [claim] = await store.claimTenantTelemetryWriteJobs({
        limit: 1, leaseMs: 30_000, claimToken: "retained-reserved-claim",
        adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2", freshProof: source.proof,
      });
      expect(claim?.writeOperationSha256).toBe(committed.failureCommitReceipt.writeOperationSha256);
      authorization = {
        tenantId, writeOperationSha256: claim!.writeOperationSha256,
        claimAttempt: claim!.claimAttempt, claimToken: claim!.claimToken,
      };
      expect(await store.reserveTenantTelemetryExternalMutation(
        authorization, "telemetry-s3-object-v1", source.proof,
      )).not.toBeNull();
      result = tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1", {
        writeOperationSha256: claim!.writeOperationSha256,
        target: claim!.target, inventory: claim!.inventory, payload: claim!.payload,
      }, "already_present", true);
    }
    const input = admissionInput(tenantId);
    await store.requestTenantErasure(input);
    const frozenReceipt = await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, input.requestId);
    const frozenEntries = await store.getTenantTelemetryRetainedSourceT1CohortEntries(tenantId, input.requestId);
    expect(frozenReceipt).toMatchObject({ eligibility: "blocked_source", entryCount: 1 });
    expect(frozenEntries).toMatchObject([{ state }]);
    if (authorization && result) {
      expect(await store.completeTenantTelemetryWrite(authorization, result, source.proof)).not.toBeNull();
      expect(await store.verifyPersistedProviderStepFailureSource(source.lookup)).toMatchObject({
        status: "source_verified_written",
      });
    }
    expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, input.requestId)).toEqual(frozenReceipt);
    expect(await store.getTenantTelemetryRetainedSourceT1CohortEntries(tenantId, input.requestId)).toEqual(frozenEntries);
    expect((await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, input.requestId))?.eligibility)
      .toBe("blocked_source");
  });

  it("records an active pre-cutover tenant as blocked instead of inventing creation coverage", async () => {
    const store = storeWithCaptureKey();
    const tenantId = "retained-old-tenant";
    await store.createApiKey(tenantId, "retained-old-key", "retained-old-hash");
    await activateCaptureFixture(store);
    const input = admissionInput(tenantId);
    await store.requestTenantErasure(input);
    const receipt = await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, input.requestId);
    expect(receipt).toMatchObject({
      eligibility: "blocked_source",
      profile: { kind: "blocked-source", legacyFailedItemCount: 0 },
    });
    if (receipt?.profile.kind !== "blocked-source") throw new Error("expected blocked-source profile");
    expect(receipt.profile.reasons).toContain("legacy_tenant");
    expect(receipt.profile.reasons).toContain("coverage_not_creation_complete");
    expect(receipt.tenantLifecycleSubjectEvidenceSha256).toBe(
      (await store.getTenantTelemetryLifecycleSubject(tenantId, input.requestId))?.receiptSha256,
    );
  });

  it("does not leak another tenant's cohort and rejects a same-tenant wrong-user source", async () => {
    const store = storeWithCaptureKey();
    await activateCaptureFixture(store);
    const tenantId = "retained-owner-tenant";
    const { committed } = await publishWrittenCapture(store, tenantId, "right-user");
    const input = admissionInput(tenantId);
    await store.requestTenantErasure(input);
    expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt("other-tenant", input.requestId)).toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceT1CohortEntries("other-tenant", input.requestId)).toEqual([]);
    expect((await store.getTenantTelemetryRetainedSourceT1CohortEntries(tenantId, input.requestId))[0])
      .toMatchObject({ writeOperationSha256: committed.failureCommitReceipt.writeOperationSha256 });

    await registerTenant(store, "wrong-user-tenant");
    const another = await captureStepFixture(store, { tenantId: "wrong-user-tenant", userId: "right-user" });
    await store.commitPersistedProviderStepFailure(admitCaptureFixtureInput(another));
    const usage = store.usageLedger.find((row) => row.sessionId === another.session.id);
    if (!usage) throw new Error("fixture usage missing");
    usage.userId = "wrong-user";
    const wrongInput = admissionInput(another.session.tenantId);
    await expect(store.requestTenantErasure(wrongInput)).rejects.toThrow();
    expect(await store.getTenantErasureRequest(another.session.tenantId, wrongInput.requestId)).toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(another.session.tenantId, wrongInput.requestId)).toBeNull();
  });

  it("rolls back admission, fence, subject and cohort when T1 publication fails, then accepts exact retry", async () => {
    const store = storeWithCaptureKey();
    await activateCaptureFixture(store);
    const tenantId = "retained-atomic-tenant";
    await registerTenant(store, tenantId);
    const source = await captureStepFixture(store, { tenantId, userId: "atomic-user" });
    await store.commitPersistedProviderStepFailure(admitCaptureFixtureInput(source));
    const input = admissionInput(tenantId);
    const internals = store as unknown as {
      retainedSourceT1Entries: Map<string, unknown>;
      retainedSourceAdmissionFamilies: Map<string, unknown>;
    };
    const entries = internals.retainedSourceT1Entries;
    const completeBefore = currentCaptureMemorySnapshot(store);
    const originalSet = entries.set.bind(entries);
    let fail = true;
    Object.defineProperty(entries, "set", {
      configurable: true,
      value: (key: string, value: unknown) => {
        if (fail) {
          fail = false;
          throw new Error("injected cohort publication failure");
        }
        return originalSet(key, value);
      },
    });
    await expect(store.requestTenantErasure(input)).rejects.toThrow("injected cohort publication failure");
    expect(await store.getTenantErasureRequest(tenantId, input.requestId)).toBeNull();
    expect(await store.getTenantCredentialRevocationFence(tenantId, input.requestId)).toBeNull();
    expect(await store.getTenantTelemetryLifecycleSubject(tenantId, input.requestId)).toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, input.requestId)).toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceT1CohortEntries(tenantId, input.requestId)).toEqual([]);
    expect(internals.retainedSourceAdmissionFamilies.has(input.requestId)).toBe(false);
    expect(currentCaptureMemorySnapshot(store)).toEqual(completeBefore);
    const admitted = await store.requestTenantErasure(input);
    expect(admitted.requestId).toBe(input.requestId);
    expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, input.requestId))
      .toMatchObject({ eligibility: "blocked_source", pendingCount: 1 });
  });

  it("rejects input serialization before any T1 state is published", async () => {
    const store = storeWithCaptureKey();
    await activateCaptureFixture(store);
    const tenantId = "retained-serialization-tenant";
    await registerTenant(store, tenantId);
    await store.createSession(mkSession(tenantId, "serialization-user"));
    const input = admissionInput(tenantId);
    const completeBefore = currentCaptureMemorySnapshot(store);
    const failure = vi.spyOn(globalThis, "structuredClone")
      .mockImplementationOnce(() => { throw new Error("injected T1 serialization failure"); });
    try {
      await expect(store.requestTenantErasure(input)).rejects.toThrow("injected T1 serialization failure");
    } finally {
      failure.mockRestore();
    }
    expect(currentCaptureMemorySnapshot(store)).toEqual(completeBefore);
    expect(await store.getTenantErasureRequest(tenantId, input.requestId)).toBeNull();
    expect(await store.getTenantCredentialRevocationFence(tenantId, input.requestId)).toBeNull();
    expect(await store.getTenantTelemetryLifecycleSubject(tenantId, input.requestId)).toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, input.requestId)).toBeNull();
  });
});
