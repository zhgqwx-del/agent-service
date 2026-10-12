import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
  MemorySessionStore,
  TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
  TENANT_TELEMETRY_DISPOSITION_JOB_SCOPE,
  TENANT_TELEMETRY_DISPOSITION_FLEET_STOPPED_ACK,
  TENANT_TELEMETRY_DISPOSITION_LEGACY_WRITERS_DRAINED_ACK,
  TENANT_TELEMETRY_DISPOSITION_REPLAY_FENCE_SCOPE,
  TENANT_TELEMETRY_EXTERNAL_AUTHORIZATION_SCOPE,
  tenantTelemetryDispositionExternalEventSha256,
  tenantTelemetryDispositionNextEventRootSha256,
  tenantTelemetryExternalAuthorizationReceiptSha256,
  validateTenantTelemetryDispositionAuthorization,
  validateTenantTelemetryDispositionJobRecord,
  tenantRestoreLogicalDatabaseNamespaceSha256,
  tenantRestoreRuntimeEpochSha256,
  type TenantTelemetryDispositionActivationReceipt,
  type TenantTelemetryDispositionJobRecord,
} from "../src/index.js";
import { dispositionEvidence } from "./tenant-telemetry-disposition.fixture.js";

const D = (label: string) => createHash("sha256").update(label).digest("hex");

class FailOnceMap<K, V> extends Map<K, V> {
  private fail = true;
  override set(key: K, value: V): this {
    if (this.fail) {
      this.fail = false;
      throw new Error("injected disposition receipt failure");
    }
    return super.set(key, value);
  }
}

async function fixture(): Promise<{
  store: MemorySessionStore;
  input: Parameters<MemorySessionStore["activateTenantTelemetryDisposition"]>[0];
}> {
  const store = new MemorySessionStore(
    { now: () => 10_000 },
    { tenantTelemetryRefKey: new Uint8Array(32).fill(0x36) },
  );
  const logicalDatabaseNamespaceSha256 =
    tenantRestoreLogicalDatabaseNamespaceSha256("telemetry-disposition-memory-test");
  const restoreTarget = {
    targetOrdinal: 0,
    targetSha256: D("restore-target"),
    failureDomainSha256: D("restore-failure-domain"),
    adapterProtocol: "memory-restore-journal-v1",
    journalNamespaceSha256: D("restore-journal-namespace"),
  };
  await store.activateTenantRestoreJournalControl({
    adapterProtocol: restoreTarget.adapterProtocol,
    journalNamespaceSha256: restoreTarget.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256,
    runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("disposition-primary"),
    targets: [restoreTarget],
    observedHeads: [{
      ...restoreTarget,
      logicalDatabaseNamespaceSha256,
      sealedRemoteSequence: 0,
      sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
    }],
  });
  const journal = await store.getTenantRestoreJournalControl();
  if (journal.controlGeneration !== 1) throw new Error("journal fixture inactive");
  await store.activateBlobStorageControl({
    expectedControlGeneration: 0,
    storageBackend: "memory-v1",
    namespaceSha256: D("blob-namespace"),
  });
  await store.activateTenantBackupCatalogControl({
    expectedControlGeneration: 0,
    adapterProtocol: "memory-backup-catalog-v1",
    catalogNamespaceSha256: D("backup-namespace"),
    catalogTargetSha256: D("backup-target"),
    failureDomainSha256: D("backup-failure-domain"),
    logicalDatabaseNamespaceSha256,
    journalControlEvidenceSha256: journal.evidenceSha256,
    retentionPolicySha256: D("backup-retention"),
    minimumRetentionMs: 1,
    minimumRecoverableBackups: 1,
  });
  await store.activateTenantTelemetryLifecycle({
    expectedControlGeneration: 0,
    targets: [
      {
        domain: "logs",
        backendKind: "memory",
        adapterProtocol: "telemetry-memory-v1",
        namespaceSha256: D("logs-namespace"),
        failureDomainSha256: D("logs-failure-domain"),
      },
      {
        domain: "traces",
        backendKind: "memory",
        adapterProtocol: "telemetry-memory-v1",
        namespaceSha256: D("traces-namespace"),
        failureDomainSha256: D("traces-failure-domain"),
      },
    ],
  });
  const lifecycle = await store.getTenantTelemetryLifecycleControl();
  if (lifecycle.state !== "active") throw new Error("telemetry fixture inactive");
  return {
    store,
    input: {
      expectedControlGeneration: 0,
      expectedLifecycleControlGeneration: 1,
      lifecycleTargetRootSha256: lifecycle.targetRootSha256,
      adapterProtocol: "memory-telemetry-disposition-journal-v1",
      journalNamespaceSha256: D("disposition-journal-namespace"),
      journalTargetSha256: D("disposition-journal-target"),
      failureDomainSha256: D("disposition-failure-domain"),
      logicalDatabaseNamespaceSha256,
      fleetStoppedAck: TENANT_TELEMETRY_DISPOSITION_FLEET_STOPPED_ACK,
      legacyWritersDrainedAck:
        TENANT_TELEMETRY_DISPOSITION_LEGACY_WRITERS_DRAINED_ACK,
    },
  };
}

describe("MemorySessionStore tenant telemetry disposition substrate", () => {
  it("accepts Unicode tenant IDs under the existing core length boundary", () => {
    const tenantId = "租户🌟";
    const evidence = dispositionEvidence();
    const job: TenantTelemetryDispositionJobRecord = {
      scope: TENANT_TELEMETRY_DISPOSITION_JOB_SCOPE,
      protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
      tenantId,
      requestId: "unicode-request",
      ...evidence,
      phase: "queued",
      attempts: 0,
      availableAtDbMs: 1,
      createdAtDbMs: 1,
      updatedAtDbMs: 1,
    };
    expect(() => validateTenantTelemetryDispositionJobRecord(job)).not.toThrow();
    expect(() => validateTenantTelemetryDispositionAuthorization({
      tenantId,
      requestId: job.requestId,
      dispositionOperationSha256: evidence.dispositionOperationSha256,
      claimAttempt: 1,
      claimToken: "unicode-claim",
    })).not.toThrow();
    expect(() => validateTenantTelemetryDispositionJobRecord({
      ...job, tenantId: "x".repeat(129),
    })).toThrow(/owner is invalid/);
    expect(() => validateTenantTelemetryDispositionJobRecord({
      ...job, tenantId: "🌟".repeat(65),
    })).toThrow(/owner is invalid/);
    expect(() => validateTenantTelemetryDispositionJobRecord({
      ...job, tenantId: "",
    })).toThrow(/owner is invalid/);
  });

  it("stays dormant and rejects a mismatched logical restore namespace", async () => {
    const { store, input } = await fixture();
    expect(await store.getTenantTelemetryDispositionControl()).toEqual({
      singletonId: "tenant-telemetry-disposition-control",
      state: "inactive",
      controlGeneration: 0,
    });
    await expect(store.activateTenantTelemetryDisposition({
      ...input,
      logicalDatabaseNamespaceSha256: D("wrong-physical-database"),
    })).rejects.toThrow(/activation source is incomplete/);
    expect(await store.getTenantTelemetryDispositionActivationReceipt()).toBeNull();
    expect(await store.getTenantTelemetryDispositionControl()).toMatchObject({
      state: "inactive",
    });
  });

  it("atomically publishes a write-once control and receipt; no T3d job becomes executable", async () => {
    const { store, input } = await fixture();
    await store.createApiKey("生产租户🌟", "unicode-key", D("unicode-key"));
    const activated = await store.activateTenantTelemetryDisposition(input);
    expect(await store.getTenantTelemetryDispositionControl()).toEqual(activated.control);
    expect(await store.getTenantTelemetryDispositionActivationReceipt())
      .toEqual(activated.receipt);
    expect(activated.receipt.activationEvidenceSha256)
      .toBe(activated.control.activationEvidenceSha256);
    await expect(store.activateTenantTelemetryDisposition(input))
      .rejects.toThrow(/already activated/);
    expect(await store.materializeTenantTelemetryDispositionJobs({ limit: 10 })).toBe(0);
    expect(await store.claimTenantTelemetryDispositions({
      limit: 10, leaseMs: 1_000, claimToken: "disposition-test-claim",
    }))
      .toEqual([]);
    expect(store.tenantTelemetryDispositionJobs.size).toBe(0);
  });

  it("rolls back control when receipt publication fails", async () => {
    const { store, input } = await fixture();
    store.tenantTelemetryDispositionActivationReceipts =
      new FailOnceMap<string, TenantTelemetryDispositionActivationReceipt>();
    await expect(store.activateTenantTelemetryDisposition(input))
      .rejects.toThrow(/injected disposition receipt failure/);
    expect(await store.getTenantTelemetryDispositionControl()).toMatchObject({
      state: "inactive", controlGeneration: 0,
    });
    expect(await store.getTenantTelemetryDispositionActivationReceipt()).toBeNull();
    const activated = await store.activateTenantTelemetryDisposition(input);
    expect(activated.control.state).toBe("active");
  });

  it("rejects forged journal/fence inputs without writing any authority projection", async () => {
    const { store, input } = await fixture();
    await store.activateTenantTelemetryDisposition(input);
    const evidence = dispositionEvidence();
    const body = {
      scope: TENANT_TELEMETRY_EXTERNAL_AUTHORIZATION_SCOPE,
      protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
      ...evidence,
      adapterProtocol: input.adapterProtocol,
      journalNamespaceSha256: input.journalNamespaceSha256,
      journalTargetSha256: input.journalTargetSha256,
      failureDomainSha256: input.failureDomainSha256,
      logicalDatabaseNamespaceSha256: input.logicalDatabaseNamespaceSha256,
    };
    const authorizationReceiptSha256 =
      tenantTelemetryExternalAuthorizationReceiptSha256(body);
    const journalEventSha256 = tenantTelemetryDispositionExternalEventSha256({
      eventType: "delete_authorized",
      dispositionOperationSha256: evidence.dispositionOperationSha256,
      eventReceiptSha256: authorizationReceiptSha256,
    });
    const journalEventRootSha256 = tenantTelemetryDispositionNextEventRootSha256({
      journalSequence: 1,
      previousJournalEventRootSha256:
        EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
      journalEventSha256,
    });
    await expect(store.mirrorTenantTelemetryDispositionExternalEvent({
      eventType: "delete_authorized",
      result: {
        ...body,
        authorizationReceiptSha256,
        journalSequence: 1,
        previousJournalEventRootSha256:
          EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
        journalEventSha256,
        journalEventRootSha256,
      },
    })).rejects.toThrow(/unverified external authority head/);
    await expect(store.sealTenantTelemetryDispositionReplayFence({
      scope: TENANT_TELEMETRY_DISPOSITION_REPLAY_FENCE_SCOPE,
      protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
      domain: evidence.domain,
      targetSha256: evidence.targetSha256,
      artifactIdSha256: evidence.artifactIdSha256,
      artifactGeneration: evidence.artifactGeneration,
      dispositionOperationSha256: evidence.dispositionOperationSha256,
      authorizationReceiptSha256,
      tombstoneReceiptSha256: D("forged-tombstone-receipt"),
      terminalReceiptSha256: D("forged-terminal-receipt"),
      journalTargetSha256: input.journalTargetSha256,
      terminalJournalSequence: 1,
      terminalJournalEventRootSha256: journalEventRootSha256,
      sealedJournalSequence: 1,
      sealedJournalEventRootSha256: journalEventRootSha256,
      restoreRunSha256: null,
      runtimeEpochSha256: null,
    })).rejects.toThrow(/verified external head and restore run/);
    expect(store.tenantTelemetryDispositionExternalEvents.size).toBe(0);
    expect(store.tenantTelemetryDispositionReplayFences.size).toBe(0);
  });
});
