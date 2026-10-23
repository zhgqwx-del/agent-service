import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
} from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  MemorySessionStore,
  TenantTelemetryRetainedSourceIntegrityError,
  newErasureRequestId,
  tenantErasureRequestHash,
  tenantRestoreJournalNextRemoteHeadRootSha256,
  tenantTelemetryWriteAdapterResult,
  type RetentionPolicyDocumentV1,
  type TenantContentInventoryAuthorization,
  type TenantCredentialRevocationAuthorization,
  type TenantPurgePlanAuthorization,
  type TenantRestoreJournalPublicationAuthorization,
  type TenantRuntimeRevocationAuthorization,
} from "../src/index.js";
import {
  activateCaptureFixture,
  captureRefKey,
  captureCurrentStepFixture as captureStepFixture,
} from "./persisted-provider-capture.fixture.js";
import { admitCaptureFixtureInput, currentCaptureMemorySnapshot } from "./fixtures/capture-current-authority.js";
import { newId } from "./conformance.js";

const tenantIdFor = (label: string) => `retained-t3d-${label}-${randomUUID()}`;

function policy(): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: 0,
    userErasureGraceMs: 0,
    operationalUsageRetentionMs: 0,
    idempotencyReceiptRetentionMs: 0,
    billingFactRetentionMs: null,
    lifecycleAuditRetentionMs: null,
    exportArtifactTtlMs: 60_000,
  };
}

const auth = {
  publication(claim: Awaited<ReturnType<MemorySessionStore["claimTenantRestoreJournalPublications"]>>[number]):
    TenantRestoreJournalPublicationAuthorization {
    return {
      requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, publicationGeneration: claim.publicationGeneration,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken,
    };
  },
  credential(claim: Awaited<ReturnType<MemorySessionStore["claimTenantCredentialRevocations"]>>[number]):
    TenantCredentialRevocationAuthorization {
    return {
      requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, claimAttempt: claim.claimAttempt,
      claimToken: claim.claimToken,
    };
  },
  runtime(claim: Awaited<ReturnType<MemorySessionStore["claimTenantRuntimeRevocations"]>>[number]):
    TenantRuntimeRevocationAuthorization {
    return {
      requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, claimAttempt: claim.claimAttempt,
      claimToken: claim.claimToken,
    };
  },
  inventory(claim: Awaited<ReturnType<MemorySessionStore["claimTenantContentInventories"]>>[number]):
    TenantContentInventoryAuthorization {
    return {
      requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, buildGeneration: claim.buildGeneration,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken,
    };
  },
  plan(claim: Awaited<ReturnType<MemorySessionStore["claimTenantPurgePlans"]>>[number]):
    TenantPurgePlanAuthorization {
    return {
      requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, buildGeneration: claim.buildGeneration,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken,
    };
  },
};

async function exactPublicationAck(store: MemorySessionStore, requestId: string) {
  const [claim] = (await store.claimTenantRestoreJournalPublications({
    limit: 1, leaseMs: 30_000, claimToken: `retained-publication-${randomUUID()}`,
  })).filter((candidate) => candidate.requestId === requestId);
  if (!claim) throw new Error("missing T1 publication claim");
  const authorization = auth.publication(claim);
  const pending = await store.getTenantRestoreJournalPublicationRecord(authorization, 0);
  if (!pending) throw new Error("missing T1 publication record");
  const previousHeadRootSha256 = EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256;
  const result = {
    adapterProtocol: pending.target.adapterProtocol,
    journalNamespaceSha256: pending.target.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: pending.target.logicalDatabaseNamespaceSha256,
    targetSha256: pending.target.targetSha256,
    remoteSequence: 1,
    previousHeadRootSha256,
    headRootSha256: tenantRestoreJournalNextRemoteHeadRootSha256({
      previousHeadRootSha256,
      targetSha256: pending.target.targetSha256,
      remoteSequence: 1,
      operationSha256: pending.record.operationSha256,
      recordSha256: pending.record.recordSha256,
    }),
    record: pending.record,
    replayed: false,
  };
  expect(await store.recordTenantRestoreJournalPublicationTargetAck(authorization, result))
    .toMatchObject({ targetOrdinal: 0, remoteSequence: 1 });
  expect(await store.sealTenantRestoreJournalPublication(authorization))
    .toMatchObject({ targetAckCount: 1, restoreFencePublicationComplete: true });
}

function fleetProof(source: {
  requestId: string; tenantId: string; subjectGeneration: number; t3aReceiptSha256: string;
}) {
  const body = {
    targetSha256: tenantRuntimeTargetSha256("http://runner-1.internal:8080"),
    runnerId: "runner-1", bootId: "boot-1",
    requestId: source.requestId, tenantId: source.tenantId,
    subjectGeneration: source.subjectGeneration, t3aReceiptSha256: source.t3aReceiptSha256,
    cacheEntryCountBefore: 1, cacheEntryCountAfter: 0 as const,
    activeOperationCountBefore: 1, activeOperationCountAfter: 0 as const,
    activeTurnCountBefore: 1, activeTurnCountAfter: 0 as const,
    completedAtMs: Date.now(),
  };
  const targets = [{ ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) }];
  return {
    fleetSha256: tenantRuntimeFleetSha256(targets),
    targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets),
    targets,
  };
}

type CaptureMode = "none" | "written" | "pending" | "reserved";

async function prepareThroughPlanClaim(mode: CaptureMode) {
  const store = new MemorySessionStore(
    { now: () => Date.now() },
    { tenantTelemetryRefKey: captureRefKey, tenantTelemetryPersistedProviderCaptureLocalOnly: true },
  );
  await activateCaptureFixture(store);
  const tenantId = tenantIdFor(mode);
  // A canonical tenant is created by the real governance writer, not by createSession.
  await store.createApiKey(tenantId, `key-${tenantId}`, `hash-${tenantId}`);
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await store.putRetentionPolicy({
    tenantId, policyVersion: "retained-source-zero-day", policy: policy(),
    actorKeyId: "retained-policy-admin", atMs: Date.now(),
  });
  await store.activateRetentionPolicy({
    tenantId, policyVersion: "retained-source-zero-day",
    expectedControlGeneration: 0, actorKeyId: "retained-policy-admin", atMs: Date.now(),
  });
  await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });

  let capture: Awaited<ReturnType<typeof captureStepFixture>> | null = null;
  let lateAck: (() => Promise<unknown>) | null = null;
  if (mode !== "none") {
    capture = await captureStepFixture(store, { tenantId, userId: `user-${mode}` });
    const committed = await store.commitPersistedProviderStepFailure(admitCaptureFixtureInput(capture));
    if (mode === "written" || mode === "reserved") {
      const [claim] = await store.claimTenantTelemetryWriteJobs({
        limit: 1, leaseMs: 30_000, claimToken: `retained-${mode}-${randomUUID()}`,
        adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2",
        freshProof: capture.proof,
      });
      if (!claim || claim.writeOperationSha256 !== committed.failureCommitReceipt.writeOperationSha256) {
        throw new Error("missing exact v2 write claim");
      }
      const authorization = {
        tenantId, writeOperationSha256: claim.writeOperationSha256,
        claimAttempt: claim.claimAttempt, claimToken: claim.claimToken,
      };
      expect(await store.reserveTenantTelemetryExternalMutation(
        authorization, "telemetry-s3-object-v1", capture.proof,
      )).not.toBeNull();
      const result = tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1", {
        writeOperationSha256: claim.writeOperationSha256,
        target: claim.target, inventory: claim.inventory, payload: claim.payload,
      }, "already_present", true);
      lateAck = () => store.completeTenantTelemetryWrite(authorization, result, capture!.proof);
      if (mode === "written") expect(await lateAck()).not.toBeNull();
    }
    // T3c observes a finished turn; the sealed provider-step receipt retains its exact event range.
    await store.commit(capture.lease.admit({
      sessionId: capture.session.id, fence: 1,
      turn: { ...capture.batch.turn!, status: "failed", stopReason: "error", completedAtMs: Date.now() },
      sessionPatch: { status: { type: "idle" } },
    }));
  }

  const request = {
    requestId: newErasureRequestId(), tenantId,
    requestedByKeyId: "retained-source-unit-admin",
    idempotencyKey: `retained-source-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now(),
  };
  await store.requestTenantErasure(request);
  const cohort = await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId);
  if (!cohort) throw new Error("missing genuine 0054 T1 cohort");
  await exactPublicationAck(store, request.requestId);

  const [credentialClaim] = (await store.claimTenantCredentialRevocations({
    limit: 1, leaseMs: 30_000, claimToken: `retained-t3a-${randomUUID()}`,
  })).filter((candidate) => candidate.requestId === request.requestId);
  if (!credentialClaim) throw new Error("missing T3a claim");
  expect(await store.revokeTenantCredentialMaterial(auth.credential(credentialClaim))).not.toBeNull();

  expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 1 })).toBe(1);
  const [runtimeClaim] = (await store.claimTenantRuntimeRevocations({
    limit: 1, leaseMs: 30_000, claimToken: `retained-t3b-${randomUUID()}`,
  })).filter((candidate) => candidate.requestId === request.requestId);
  if (!runtimeClaim) throw new Error("missing T3b claim");
  expect(await store.completeTenantRuntimeRevocation(auth.runtime(runtimeClaim), fleetProof(runtimeClaim)))
    .not.toBeNull();

  expect(await store.materializeTenantContentInventoryJobs({ limit: 1 })).toBe(1);
  const [inventoryClaim] = (await store.claimTenantContentInventories({
    limit: 1, leaseMs: 30_000, claimToken: `retained-t3c-${randomUUID()}`,
  })).filter((candidate) => candidate.requestId === request.requestId);
  if (!inventoryClaim) throw new Error("missing T3c claim");
  const inventoryAuthorization = auth.inventory(inventoryClaim);
  await store.buildTenantContentInventoryPage(inventoryAuthorization, { limit: 100 });
  expect(await store.sealTenantContentInventory(inventoryAuthorization)).not.toBeNull();

  expect(await store.materializeTenantPurgePlanJobs({ limit: 1 })).toBe(1);
  const [planClaim] = (await store.claimTenantPurgePlans({
    limit: 1, leaseMs: 30_000, claimToken: `retained-t3d-${randomUUID()}`,
  })).filter((candidate) => candidate.requestId === request.requestId);
  if (!planClaim) throw new Error("missing T3d claim");
  return { store, tenantId, request, cohort, capture, lateAck,
    planAuthorization: auth.plan(planClaim) };
}

describe("0054 retained-source T3d Memory non-destructive catalog", () => {
  it("seals a real v2 written artifact and each of its six physical source rows without an old 0042 receipt", async () => {
    const fixture = await prepareThroughPlanClaim("written");
    const { store, tenantId, request, cohort, planAuthorization } = fixture;
    const sealed = await store.sealTenantPurgePlan(planAuthorization);
    expect(sealed).toMatchObject({ requestId: request.requestId, planComplete: true, executionReady: false });
    const catalog = await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId);
    const targets = await store.getTenantTelemetryRetainedSourceCatalogTargets(tenantId, request.requestId);
    const sources = await store.getTenantTelemetryRetainedSourceCatalogSourceEntries(tenantId, request.requestId);
    expect(cohort).toMatchObject({ eligibility: "eligible_retained", writtenAckCount: 1 });
    expect(catalog).toMatchObject({
      cohortReceiptSha256: cohort.receiptSha256,
      sourceCount: 6, inventoryCount: 1, writeJobCount: 1, writeAckCount: 1,
      membershipCount: 1, applicationBindingCount: 0,
      providerSourceBindingCount: 1, providerFailureCommitCount: 1,
      unknownSourceCount: 0, entryCount: 1, applicationV1Count: 0,
      persistedProviderV2Count: 1, logsTargetCount: 1, tracesTargetCount: 0,
      executionReady: false, externalAuthorityVerified: false,
      allDomainsComplete: false, contentPurgeExecuted: false,
    });
    expect(targets).toMatchObject([{ domain: "logs", source: { kind: "persisted-provider-v2" } }]);
    expect(sources).toHaveLength(6);
    expect(new Set(sources.map((source) => source.sourceKind))).toEqual(new Set([
      "inventory", "write_job", "write_ack", "membership", "provider_source_binding", "provider_failure_commit",
    ]));
    expect(sources.every((source) => source.classification === "accounted"
      && source.catalogTargetEntryReceiptSha256 === targets[0]?.receiptSha256)).toBe(true);
    expect(await store.getTenantTelemetrySourceAccountingReceipt(tenantId, request.requestId)).not.toBeNull();
    expect(await store.getTenantTelemetryTargetManifestReceipt(tenantId, request.requestId)).not.toBeNull();
    expect(await store.getTenantTelemetryPlanArtifactTargetReceipt(tenantId, request.requestId)).toBeNull();
    expect(await store.getTenantTelemetryPlanArtifactTargets(tenantId, request.requestId)).toEqual([]);
    expect(await store.sealTenantPurgePlan(planAuthorization)).toEqual(sealed);
    expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId)).toEqual(catalog);
    expect(await store.getTenantTelemetryRetainedSourceCatalogTargets("other-tenant", request.requestId)).toEqual([]);
    expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt("other-tenant", request.requestId)).toBeNull();
  });

  it("seals an explicit new-family empty catalog and refuses a lost receipt even for zero targets", async () => {
    const { store, tenantId, request, cohort, planAuthorization } = await prepareThroughPlanClaim("none");
    expect(cohort).toMatchObject({ eligibility: "eligible_retained", entryCount: 0 });
    await store.sealTenantPurgePlan(planAuthorization);
    const catalog = await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId);
    expect(catalog).toMatchObject({ sourceCount: 0, entryCount: 0, logsTargetCount: 0, tracesTargetCount: 0 });
    expect(await store.getTenantTelemetryRetainedSourceCatalogTargets(tenantId, request.requestId)).toEqual([]);
    expect(await store.getTenantTelemetryRetainedSourceCatalogSourceEntries(tenantId, request.requestId)).toEqual([]);
    expect(await store.getTenantTelemetryPlanArtifactTargetReceipt(tenantId, request.requestId)).toBeNull();
    const internals = store as unknown as { retainedSourceCatalogReceipts: Map<string, unknown> };
    internals.retainedSourceCatalogReceipts.delete(request.requestId);
    await expect(store.getTenantPurgePlanReceipt(tenantId, request.requestId)).rejects.toThrow();
  });

  it("rolls back late catalog publication and accepts exact same-claim retry", async () => {
    const { store, tenantId, request, planAuthorization } = await prepareThroughPlanClaim("written");
    const targetMap = (store as unknown as {
      retainedSourceCatalogTargets: Map<string, unknown>;
    }).retainedSourceCatalogTargets;
    const originalSet = targetMap.set.bind(targetMap);
    const completeBefore = currentCaptureMemorySnapshot(store);
    let fail = true;
    Object.defineProperty(targetMap, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof originalSet>[1]) => {
        if (fail) { fail = false; throw new Error("injected T3d target publication failure"); }
        return originalSet(key, value);
      },
    });
    await expect(store.sealTenantPurgePlan(planAuthorization))
      .rejects.toThrow("injected T3d target publication failure");
    expect(await store.getTenantPurgePlanReceipt(tenantId, request.requestId)).toBeNull();
    expect(await store.getTenantTelemetrySourceAccountingReceipt(tenantId, request.requestId)).toBeNull();
    expect(await store.getTenantTelemetryTargetManifestReceipt(tenantId, request.requestId)).toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId)).toBeNull();
    expect(targetMap.size).toBe(0);
    expect((await store.getTenantPurgePlanJob(tenantId, request.requestId))?.phase).toBe("queued");
    expect(currentCaptureMemorySnapshot(store)).toEqual(completeBefore);
    const sealed = await store.sealTenantPurgePlan(planAuthorization);
    expect(sealed).not.toBeNull();
    expect(await store.sealTenantPurgePlan(planAuthorization)).toEqual(sealed);
  });

  it("rechecks the original canonical failed item and event, not merely their row counts", async () => {
    const { store, tenantId, request, capture, planAuthorization } =
      await prepareThroughPlanClaim("written");
    if (!capture) throw new Error("missing v2 source fixture");
    await store.sealTenantPurgePlan(planAuthorization);
    const original = await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId);
    expect(original?.persistedProviderV2Count).toBe(1);

    const originalItem = structuredClone(store.items.get(capture.item.id)!);
    const replacedItem = { ...originalItem, id: newId("item") };
    store.items.delete(originalItem.id);
    store.items.set(replacedItem.id, replacedItem);
    expect(store.items.size).toBe(1);
    await expect(store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
      .rejects.toThrow();
    store.items.delete(replacedItem.id);
    store.items.set(originalItem.id, originalItem);
    expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
      .toEqual(original);

    const originalEvents = structuredClone(store.events.get(capture.session.id)!);
    let changed = false;
    const forgedEvents = originalEvents.map((event) => {
      if (event.type !== "item/completed" || event.item.id !== capture.item.id) return event;
      if (event.item.type !== "agentMessage") throw new Error("expected failed agent item");
      changed = true;
      return { ...event, item: { ...event.item, text: "changed canonical event" } };
    });
    expect(changed).toBe(true);
    store.events.set(capture.session.id, forgedEvents);
    expect(store.events.get(capture.session.id)).toHaveLength(originalEvents.length);
    await expect(store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
      .rejects.toThrow();
    store.events.set(capture.session.id, originalEvents);
    expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
      .toEqual(original);
  });

  it("does not treat a fabricated historical receipt as permission to bypass live source validation", async () => {
    const { store, tenantId, request, capture, planAuthorization } =
      await prepareThroughPlanClaim("written");
    if (!capture) throw new Error("missing v2 source fixture");
    await store.sealTenantPurgePlan(planAuthorization);
    const original = await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId);
    const historical = (store as unknown as {
      retainedSourceUsageReceipts: Map<string, unknown>;
    }).retainedSourceUsageReceipts;
    historical.set(request.requestId, { forgedHistoricalReceipt: true });
    const savedItem = store.items.get(capture.item.id);
    if (!savedItem || savedItem.type !== "agentMessage") {
      throw new Error("expected original failed agent item");
    }
    const originalItem = structuredClone(savedItem);
    store.items.set(originalItem.id, { ...originalItem, text: "changed original failure" });
    await expect(store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
      .rejects.toThrow();
    store.items.set(originalItem.id, originalItem);
    await expect(store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
      .rejects.toThrow();
    historical.delete(request.requestId);
    expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
      .toEqual(original);
  });

  it("refuses T3d seal for pending or reserved T1 cohorts even after a late ACK, without partial publication", async () => {
    for (const mode of ["pending", "reserved"] as const) {
      const { store, tenantId, request, cohort, lateAck, planAuthorization } =
        await prepareThroughPlanClaim(mode);
      expect(cohort).toMatchObject({ eligibility: "blocked_source", entryCount: 1 });
      if (lateAck) expect(await lateAck()).not.toBeNull();
      await expect(store.sealTenantPurgePlan(planAuthorization))
        .rejects.toThrow(TenantTelemetryRetainedSourceIntegrityError);
      expect(await store.getTenantPurgePlanReceipt(tenantId, request.requestId)).toBeNull();
      expect((await store.getTenantPurgePlanJob(tenantId, request.requestId))?.phase).toBe("queued");
      expect(await store.getTenantTelemetrySourceAccountingReceipt(tenantId, request.requestId)).toBeNull();
      expect(await store.getTenantTelemetryTargetManifestReceipt(tenantId, request.requestId)).toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId)).toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceCatalogTargets(tenantId, request.requestId)).toEqual([]);
      const publications = store as unknown as {
        retainedSourceCatalogSources: Map<string, unknown>;
        retainedSourceCatalogTargets: Map<string, unknown>;
        retainedSourceCatalogReceipts: Map<string, unknown>;
        retainedSourceUsageEntries: Map<string, unknown>;
        retainedSourceUsageReceipts: Map<string, unknown>;
        retainedSourceCanonicalEntries: Map<string, unknown>;
        retainedSourceCanonicalReceipts: Map<string, unknown>;
      };
      for (const field of ["retainedSourceCatalogSources", "retainedSourceCatalogTargets",
        "retainedSourceCatalogReceipts", "retainedSourceUsageEntries", "retainedSourceUsageReceipts",
        "retainedSourceCanonicalEntries", "retainedSourceCanonicalReceipts"] as const) {
        expect(publications[field].size, field).toBe(0);
      }
      expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId))
        .toEqual(cohort);
    }
  });
});
