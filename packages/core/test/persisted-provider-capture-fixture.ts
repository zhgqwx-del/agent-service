import { EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256, MemorySessionStore, s3TenantTelemetryTargetIdentity } from "@agent-service/store";

/** Atomic store-only unit fixture: no external S3 or configured-fleet availability proof. */
export async function activateMemoryPersistedProviderCapture(store: MemorySessionStore) {
  const D = (character: string) => character.repeat(64);
  const target = { targetOrdinal: 0, targetSha256: D("1"), failureDomainSha256: D("2"), adapterProtocol: "memory-restore-journal-v1", journalNamespaceSha256: D("3") };
  await store.activateTenantRestoreJournalControl({ adapterProtocol: target.adapterProtocol, journalNamespaceSha256: target.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: D("4"), runtimeEpochSha256: D("5"), targets: [target],
    observedHeads: [{ ...target, logicalDatabaseNamespaceSha256: D("4"), sealedRemoteSequence: 0, sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256 }] });
  await store.activateTenantTelemetryLifecycle({ expectedControlGeneration: 0, targets: (["logs", "traces"] as const).map((domain) => ({ domain,
    ...s3TenantTelemetryTargetIdentity({ namespaceId: "unit-capture", failureDomainId: "unit-fake", bucket: "unit-capture", prefix: "capture", region: "us-east-1", endpoint: null, forcePathStyle: false, domain }),
  })) });
  const lifecycle = await store.getTenantTelemetryLifecycleControl();
  if (lifecycle.state !== "active") throw new Error("unit lifecycle not active");
  const logs = (await store.listTenantTelemetryLifecycleTargets()).find((candidate) => candidate.domain === "logs")!;
  await store.withTenantTelemetryCaptureOperatorFence((fence) => store.activateTenantTelemetryPersistedProviderCapture({ expectedControlGeneration: 0,
    lifecycleControlEvidenceSha256: lifecycle.activationEvidenceSha256, logsTargetSha256: logs.targetSha256, logsTargetReceiptSha256: logs.receiptSha256,
    configuredFleetRootSha256: D("6"), fleetStoppedAck: "fleet-stopped-v1", legacyWritersDrainedAck: "legacy-writers-drained-v1", producerReadyAck: "provider-step-error-v2-ready-v1", localOnlyAck: "local-only-v1",
  }, fence), { timeoutMs: 1000 });
}
