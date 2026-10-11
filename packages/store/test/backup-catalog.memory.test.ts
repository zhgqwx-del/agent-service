import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  MemorySessionStore,
  TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
  TENANT_BACKUP_CATALOG_PROTOCOL,
  TenantBackupCatalogConflictError,
  TenantBackupCatalogNotReadyError,
  newTenantBackupEvictionId,
  newTenantBackupId,
  tenantBackupAvailabilityOperationSha256,
  tenantBackupAvailabilityReceiptSha256,
  tenantBackupAvailabilityResultFromEntry,
  tenantBackupCatalogEntrySha256,
  tenantBackupCatalogEventSha256,
  tenantBackupCatalogNextEventRootSha256,
  tenantBackupEvictionOperationSha256,
  tenantBackupEvictionReceiptSha256,
  tenantBackupReservationResolutionOperationSha256,
  tenantBackupReservationReceiptSha256,
  tenantBackupResolutionReceiptSha256,
  tenantBackupRuntimeReservationOperationSha256,
  tenantBackupSchemaMigrationRootSha256,
  tenantRestoreLogicalDatabaseNamespaceSha256,
  tenantRestoreRuntimeEpochSha256,
  type ActiveTenantBackupCatalogControlRecord,
  type PrepareTenantRestoreReplayFromBackupInput,
  type TenantBackupAvailabilityAdapterResult,
  type TenantBackupCatalogEntry,
  type TenantBackupCatalogEventProof,
  type TenantBackupEvictionAdapterResult,
  type TenantBackupEvictionPlan,
  type TenantBackupRuntimeReservationAdapterResult,
  type TenantRestoreJournalTargetDescriptor,
  type TenantRestoreReplaySealedTarget,
} from "../src/index.js";

function sha256(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

class TestClock {
  constructor(public value: number) {}
  now(): number { return this.value; }
}

class FailOnceMap<K, V> extends Map<K, V> {
  private fail = true;

  override set(key: K, value: V): this {
    if (this.fail) {
      this.fail = false;
      throw new Error("injected backup catalog map failure");
    }
    return super.set(key, value);
  }
}

interface Fixture {
  store: MemorySessionStore;
  clock: TestClock;
  control: ActiveTenantBackupCatalogControlRecord;
  target: TenantRestoreJournalTargetDescriptor;
  sealedTargets: TenantRestoreReplaySealedTarget[];
  schemaMigrationRootSha256: string;
  blobStorageControlEvidenceSha256: string;
}

async function fixture(minimumRecoverableBackups = 1): Promise<Fixture> {
  const clock = new TestClock(10_000);
  const schemaMigrationNames = ["0031-memory-schema"];
  const store = new MemorySessionStore(clock, { tenantBackupSchemaMigrationNames: schemaMigrationNames });
  const logicalDatabaseNamespaceSha256 =
    tenantRestoreLogicalDatabaseNamespaceSha256("backup-catalog-test-database");
  const target: TenantRestoreJournalTargetDescriptor = {
    targetOrdinal: 0,
    targetSha256: sha256("restore-target"),
    failureDomainSha256: sha256("restore-failure-domain"),
    adapterProtocol: "memory-restore-journal-v1",
    journalNamespaceSha256: sha256("restore-journal-namespace"),
  };
  const sealedTargets: TenantRestoreReplaySealedTarget[] = [{
    ...target,
    logicalDatabaseNamespaceSha256,
    sealedRemoteSequence: 0,
    sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  }];
  await store.activateTenantRestoreJournalControl({
    adapterProtocol: target.adapterProtocol,
    journalNamespaceSha256: target.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256,
    runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("backup-primary-runtime"),
    targets: [target],
    observedHeads: sealedTargets,
  });
  const journal = await store.getTenantRestoreJournalControl();
  if (journal.controlGeneration !== 1) throw new Error("journal did not activate");
  const blobStorageControl = await store.activateBlobStorageControl({
    expectedControlGeneration: 0,
    storageBackend: "memory-v1",
    namespaceSha256: sha256("backup-catalog-blob-namespace"),
  });
  const activated = await store.activateTenantBackupCatalogControl({
    expectedControlGeneration: 0,
    adapterProtocol: "memory-tenant-backup-catalog-v1",
    catalogNamespaceSha256: sha256("backup-catalog-namespace"),
    catalogTargetSha256: sha256("backup-catalog-target"),
    failureDomainSha256: sha256("backup-catalog-failure-domain"),
    logicalDatabaseNamespaceSha256,
    journalControlEvidenceSha256: journal.evidenceSha256,
    retentionPolicySha256: sha256("backup-retention-policy-v1"),
    minimumRetentionMs: 1_000,
    minimumRecoverableBackups,
  });
  return {
    store,
    clock,
    control: activated.value,
    target,
    sealedTargets,
    schemaMigrationRootSha256: tenantBackupSchemaMigrationRootSha256(schemaMigrationNames),
    blobStorageControlEvidenceSha256: blobStorageControl.evidenceSha256,
  };
}

async function anchorBackup(
  f: Fixture,
  backupId: string,
) {
  return f.store.createTenantBackupSnapshotAnchor({
    backupId,
    controlEvidenceSha256: f.control.evidenceSha256,
  });
}

function eventProof(
  catalogSequence: number,
  previousCatalogEventRootSha256: string,
  eventType: Parameters<typeof tenantBackupCatalogEventSha256>[0]["eventType"],
  operationSha256: string,
  receiptSha256: string,
): TenantBackupCatalogEventProof {
  const catalogEventSha256 = tenantBackupCatalogEventSha256({
    eventType,
    operationSha256,
    receiptSha256,
  });
  return {
    catalogSequence,
    previousCatalogEventRootSha256,
    catalogEventSha256,
    catalogEventRootSha256: tenantBackupCatalogNextEventRootSha256({
      catalogSequence,
      previousCatalogEventRootSha256,
      catalogEventSha256,
    }),
  };
}

async function publishBackup(
  f: Fixture,
  backupId: string,
  label: string,
  catalogSequence: number,
  previousCatalogEventRootSha256: string,
): Promise<TenantBackupCatalogEntry> {
  const anchor = (await anchorBackup(f, backupId)).value;
  const base = {
    backupId,
    anchorSha256: anchor.anchorSha256,
    sourceSnapshotSha256: sha256(`${label}-snapshot-identity`),
    sourceBackupSha256: sha256(`${label}-source-backup`),
    artifactManifestSha256: sha256(`${label}-artifact-manifest`),
    providerEvidenceSha256: sha256(`${label}-provider-evidence`),
    controlEvidenceSha256: anchor.controlEvidenceSha256,
    logicalDatabaseNamespaceSha256: anchor.logicalDatabaseNamespaceSha256,
    retentionPolicySha256: f.control.retentionPolicySha256,
    retentionUntilDbMs: anchor.retentionUntilDbMs,
    registeredAtDbMs: anchor.createdAtDbMs,
    catalogNamespaceSha256: f.control.catalogNamespaceSha256,
    catalogTargetSha256: f.control.catalogTargetSha256,
  };
  const availabilityOperationSha256 = tenantBackupAvailabilityOperationSha256(base);
  const availabilityReceiptSha256 = tenantBackupAvailabilityReceiptSha256({
    adapterProtocol: f.control.adapterProtocol,
    catalogNamespaceSha256: f.control.catalogNamespaceSha256,
    catalogTargetSha256: f.control.catalogTargetSha256,
    failureDomainSha256: f.control.failureDomainSha256,
  }, base, availabilityOperationSha256);
  const evidence = {
    adapterProtocol: f.control.adapterProtocol,
    failureDomainSha256: f.control.failureDomainSha256,
    ...base,
    availabilityOperationSha256,
    availabilityReceiptSha256,
    ...eventProof(
      catalogSequence,
      previousCatalogEventRootSha256,
      "backup_recoverable",
      availabilityOperationSha256,
      availabilityReceiptSha256,
    ),
  };
  const result: TenantBackupAvailabilityAdapterResult = {
    ...evidence,
    entrySha256: tenantBackupCatalogEntrySha256({
      scope: TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
      protocol: TENANT_BACKUP_CATALOG_PROTOCOL,
      ...evidence,
    }),
  };
  return (await f.store.recordTenantBackupCatalogAvailability(result)).value;
}

function reservationResult(
  f: Fixture,
  entry: TenantBackupCatalogEntry,
  restoreRunId: string,
  runtimeEpochSha256: string,
  catalogSequence: number,
  previousCatalogEventRootSha256: string,
): TenantBackupRuntimeReservationAdapterResult {
  const identity = {
    backupId: entry.backupId,
    restoreRunId,
    entrySha256: entry.entrySha256,
    runtimeEpochSha256,
  };
  const reservationOperationSha256 = tenantBackupRuntimeReservationOperationSha256(identity);
  const reservationReceiptSha256 = tenantBackupReservationReceiptSha256({
    adapterProtocol: f.control.adapterProtocol,
    catalogNamespaceSha256: f.control.catalogNamespaceSha256,
    catalogTargetSha256: f.control.catalogTargetSha256,
    failureDomainSha256: f.control.failureDomainSha256,
  }, identity, reservationOperationSha256);
  return {
    adapterProtocol: f.control.adapterProtocol,
    catalogNamespaceSha256: f.control.catalogNamespaceSha256,
    catalogTargetSha256: f.control.catalogTargetSha256,
    ...identity,
    reservationOperationSha256,
    reservationReceiptSha256,
    ...eventProof(
      catalogSequence,
      previousCatalogEventRootSha256,
      "restore_reserved",
      reservationOperationSha256,
      reservationReceiptSha256,
    ),
  };
}

function restoreInput(
  f: Fixture,
  entry: TenantBackupCatalogEntry,
  label: string,
  catalogSequence: number,
  previousCatalogEventRootSha256: string,
): PrepareTenantRestoreReplayFromBackupInput {
  const restoreRunId = `restore_${randomUUID()}`;
  const runtimeEpochSha256 = tenantRestoreRuntimeEpochSha256(label);
  return {
    backupId: entry.backupId,
    restoreRunId,
    runtimeEpochSha256,
    controlEvidenceSha256: f.control.journalControlEvidenceSha256,
    sealedTargets: structuredClone(f.sealedTargets),
    reservation: reservationResult(
      f,
      entry,
      restoreRunId,
      runtimeEpochSha256,
      catalogSequence,
      previousCatalogEventRootSha256,
    ),
  };
}

function evictionAck(
  f: Fixture,
  plan: TenantBackupEvictionPlan,
  catalogSequence: number,
  previousCatalogEventRootSha256: string,
): TenantBackupEvictionAdapterResult {
  const externalTombstoneSha256 = sha256(`external-tombstone-${plan.evictionId}`);
  const acknowledgementReceiptSha256 = tenantBackupEvictionReceiptSha256({
    plan,
    externalTombstoneSha256,
    observedAbsent: true,
  });
  return {
    adapterProtocol: f.control.adapterProtocol,
    catalogNamespaceSha256: f.control.catalogNamespaceSha256,
    catalogTargetSha256: f.control.catalogTargetSha256,
    evictionId: plan.evictionId,
    backupId: plan.backupId,
    planSha256: plan.planSha256,
    evictionOperationSha256: tenantBackupEvictionOperationSha256(plan),
    acknowledgementReceiptSha256,
    externalTombstoneSha256,
    observedAbsent: true,
    ...eventProof(
      catalogSequence,
      previousCatalogEventRootSha256,
      "backup_evicted",
      plan.evictionOperationSha256,
      acknowledgementReceiptSha256,
    ),
  };
}

describe("MemorySessionStore authoritative backup catalog", () => {
  it("keeps activation dormant until journal, runtime, and Blob control are all active", async () => {
    const store = new MemorySessionStore();
    const logicalDatabaseNamespaceSha256 =
      tenantRestoreLogicalDatabaseNamespaceSha256("backup-catalog-prerequisite-database");
    const target: TenantRestoreJournalTargetDescriptor = {
      targetOrdinal: 0,
      targetSha256: sha256("backup-catalog-prerequisite-target"),
      failureDomainSha256: sha256("backup-catalog-prerequisite-failure-domain"),
      adapterProtocol: "memory-restore-journal-v1",
      journalNamespaceSha256: sha256("backup-catalog-prerequisite-journal"),
    };
    await store.activateTenantRestoreJournalControl({
      adapterProtocol: target.adapterProtocol,
      journalNamespaceSha256: target.journalNamespaceSha256,
      logicalDatabaseNamespaceSha256,
      runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("backup-prerequisite-runtime"),
      targets: [target],
      observedHeads: [{
        ...target,
        logicalDatabaseNamespaceSha256,
        sealedRemoteSequence: 0,
        sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
      }],
    });
    const journal = await store.getTenantRestoreJournalControl();
    if (journal.controlGeneration !== 1) throw new Error("journal did not activate");
    await expect(store.activateTenantBackupCatalogControl({
      expectedControlGeneration: 0,
      adapterProtocol: "memory-tenant-backup-catalog-v1",
      catalogNamespaceSha256: sha256("backup-prerequisite-catalog"),
      catalogTargetSha256: sha256("backup-prerequisite-catalog-target"),
      failureDomainSha256: sha256("backup-prerequisite-catalog-failure-domain"),
      logicalDatabaseNamespaceSha256,
      journalControlEvidenceSha256: journal.evidenceSha256,
      retentionPolicySha256: sha256("backup-prerequisite-retention"),
      minimumRetentionMs: 1,
      minimumRecoverableBackups: 1,
    })).rejects.toBeInstanceOf(TenantBackupCatalogNotReadyError);
    await expect(store.getTenantBackupCatalogControl()).resolves.toEqual({
      singletonId: 1,
      state: "inactive",
      controlGeneration: 0,
    });
  });

  it("starts dormant and activates once with exact replay", async () => {
    const dormant = new MemorySessionStore();
    await expect(dormant.getTenantBackupCatalogControl()).resolves.toEqual({
      singletonId: 1,
      state: "inactive",
      controlGeneration: 0,
    });

    const f = await fixture();
    const replay = await f.store.activateTenantBackupCatalogControl({
      expectedControlGeneration: 0,
      adapterProtocol: f.control.adapterProtocol,
      catalogNamespaceSha256: f.control.catalogNamespaceSha256,
      catalogTargetSha256: f.control.catalogTargetSha256,
      failureDomainSha256: f.control.failureDomainSha256,
      logicalDatabaseNamespaceSha256: f.control.logicalDatabaseNamespaceSha256,
      journalControlEvidenceSha256: f.control.journalControlEvidenceSha256,
      retentionPolicySha256: f.control.retentionPolicySha256,
      minimumRetentionMs: f.control.minimumRetentionMs,
      minimumRecoverableBackups: f.control.minimumRecoverableBackups,
    });
    expect(replay).toEqual({ disposition: "exact_replay", value: f.control });
    await expect(f.store.activateTenantBackupCatalogControl({
      expectedControlGeneration: 0,
      adapterProtocol: f.control.adapterProtocol,
      catalogNamespaceSha256: sha256("different-catalog-namespace"),
      catalogTargetSha256: f.control.catalogTargetSha256,
      failureDomainSha256: f.control.failureDomainSha256,
      logicalDatabaseNamespaceSha256: f.control.logicalDatabaseNamespaceSha256,
      journalControlEvidenceSha256: f.control.journalControlEvidenceSha256,
      retentionPolicySha256: f.control.retentionPolicySha256,
      minimumRetentionMs: f.control.minimumRetentionMs,
      minimumRecoverableBackups: f.control.minimumRecoverableBackups,
    })).rejects.toBeInstanceOf(TenantBackupCatalogConflictError);
  });

  it("anchors a full backup and publishes one exact recoverable projection", async () => {
    const f = await fixture();
    const id = newTenantBackupId();
    const firstAnchor = await anchorBackup(f, id);
    expect(firstAnchor.disposition).toBe("created");
    expect(firstAnchor.value).toMatchObject({
      schemaMigrationRootSha256: f.schemaMigrationRootSha256,
      blobStorageControlEvidenceSha256: f.blobStorageControlEvidenceSha256,
      sourceRuntimeHeads: f.sealedTargets,
      sourceCatalogSequence: 0,
      sourceCatalogEventRootSha256: EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
    });
    expect((await anchorBackup(f, id)).disposition).toBe("exact_replay");
    await expect(f.store.createTenantBackupSnapshotAnchor({
      backupId: newTenantBackupId(),
      controlEvidenceSha256: f.control.evidenceSha256,
      schemaMigrationRootSha256: sha256("caller-asserted-schema"),
    } as Parameters<MemorySessionStore["createTenantBackupSnapshotAnchor"]>[0]))
      .rejects.toThrow(/unknown or missing fields/);

    f.clock.value += 777;
    const entry = await publishBackup(
      f,
      id,
      "backup-one",
      1,
      EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
    );
    expect(entry).toMatchObject({
      backupId: id,
      anchorSha256: firstAnchor.value.anchorSha256,
      catalogSequence: 1,
      registeredAtDbMs: firstAnchor.value.createdAtDbMs,
    });
    const nextAnchor = await anchorBackup(f, newTenantBackupId());
    expect(nextAnchor.value).toMatchObject({
      sourceCatalogSequence: entry.catalogSequence,
      sourceCatalogEventRootSha256: entry.catalogEventRootSha256,
    });
    const replayResult = tenantBackupAvailabilityResultFromEntry(entry);
    expect((await f.store.recordTenantBackupCatalogAvailability(replayResult)).disposition)
      .toBe("exact_replay");
    expect(await f.store.listRecoverableTenantBackups({ limit: 10 })).toEqual([entry]);

    await expect(f.store.recordTenantBackupCatalogAvailability({
      ...replayResult,
      sourceLocator: "https://credentials.example.invalid/snapshot",
    } as TenantBackupAvailabilityAdapterResult)).rejects.toThrow(/unknown or missing fields/);

    await expect(f.store.recordTenantBackupCatalogAvailability({
      ...replayResult,
      sourceBackupSha256: sha256("conflicting-source"),
    })).rejects.toThrow();
    expect(await f.store.getTenantBackupCatalogEntry(id)).toEqual(entry);
  });

  it("atomically binds a catalog backup, reservation, and 0030 replay run", async () => {
    const f = await fixture();
    const entry = await publishBackup(
      f,
      newTenantBackupId(),
      "atomic-backup",
      1,
      EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
    );
    const input = restoreInput(f, entry, "atomic-restore-epoch", 2, entry.catalogEventRootSha256);

    await expect(f.store.prepareTenantRestoreReplay({
      restoreRunId: input.restoreRunId,
      sourceBackupSha256: entry.sourceBackupSha256,
      runtimeEpochSha256: input.runtimeEpochSha256,
      controlEvidenceSha256: input.controlEvidenceSha256,
      sealedTargets: input.sealedTargets,
    })).rejects.toBeInstanceOf(TenantBackupCatalogNotReadyError);

    const catalogEventsBefore = [...f.store.tenantBackupCatalogExternalEvents.entries()];
    f.store.tenantBackupRuntimeReservations = new FailOnceMap();
    await expect(f.store.prepareTenantRestoreReplayFromBackup(input)).rejects.toThrow(
      "injected backup catalog map failure",
    );
    expect([...f.store.tenantBackupCatalogExternalEvents.entries()]).toEqual(catalogEventsBefore);
    expect(await f.store.getTenantBackupCatalogEntry(entry.backupId)).toEqual(entry);
    expect(f.store.tenantBackupRestoreSourceBindings.size).toBe(0);
    expect(f.store.tenantBackupRuntimeReservations.size).toBe(0);
    expect(f.store.tenantRestoreReplayRuns.size).toBe(0);
    expect(f.store.tenantRestoreReplaySealedTargets.size).toBe(0);

    const [first, replay] = await Promise.all([
      f.store.prepareTenantRestoreReplayFromBackup(input),
      f.store.prepareTenantRestoreReplayFromBackup(input),
    ]);
    expect([first.disposition, replay.disposition].sort()).toEqual(["created", "exact_replay"]);
    expect(first.value.binding.sourceBackupSha256).toBe(entry.sourceBackupSha256);
    expect(first.value.binding.artifactManifestSha256).toBe(entry.artifactManifestSha256);
    await expect(f.store.sealTenantRestoreReplay(input.restoreRunId)).resolves.toMatchObject({
      sourceBackupSha256: entry.sourceBackupSha256,
    });
    await expect(f.store.activateTenantRestoreRuntime({
      restoreRunId: input.restoreRunId,
      expectedControlGeneration: 1,
    })).resolves.toMatchObject({ state: "active", restoreRunId: input.restoreRunId });
    expect(await f.store.getTenantBackupRuntimeReservation(input.restoreRunId))
      .toMatchObject({ phase: "reserved" });
    const reservation = first.value.reservation;
    const resolutionOperationSha256 = tenantBackupReservationResolutionOperationSha256({
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "activated",
    });
    const resolutionReceiptSha256 = tenantBackupResolutionReceiptSha256({
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "activated",
    });
    await expect(f.store.resolveTenantBackupRuntimeReservation({
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "activated",
      resolutionOperationSha256,
      resolutionReceiptSha256,
      ...eventProof(
        3,
        reservation.catalogEventRootSha256,
        "restore_resolved",
        resolutionOperationSha256,
        resolutionReceiptSha256,
      ),
    })).resolves.toMatchObject({
      disposition: "created",
      value: { phase: "activated" },
    });
  });

  it("mirrors an external resolution before the local run is terminal and projects it on replay", async () => {
    const f = await fixture();
    const entry = await publishBackup(
      f,
      newTenantBackupId(),
      "historical-resolution",
      1,
      EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
    );
    const prepared = await f.store.prepareTenantRestoreReplayFromBackup(
      restoreInput(f, entry, "historical-resolution-epoch", 2, entry.catalogEventRootSha256),
    );
    const reservation = prepared.value.reservation;
    const resolutionOperationSha256 = tenantBackupReservationResolutionOperationSha256({
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "aborted",
    });
    const resolutionReceiptSha256 = tenantBackupResolutionReceiptSha256({
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "aborted",
    });
    const resolution = {
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "aborted" as const,
      resolutionOperationSha256,
      resolutionReceiptSha256,
      ...eventProof(
        3,
        reservation.catalogEventRootSha256,
        "restore_resolved",
        resolutionOperationSha256,
        resolutionReceiptSha256,
      ),
    };
    const mirrorInput = {
      adapterProtocol: f.control.adapterProtocol,
      catalogNamespaceSha256: f.control.catalogNamespaceSha256,
      catalogTargetSha256: f.control.catalogTargetSha256,
      failureDomainSha256: f.control.failureDomainSha256,
      event: { eventType: "restore_resolved" as const, result: resolution },
    };

    await expect(f.store.mirrorTenantBackupCatalogEvent(mirrorInput))
      .resolves.toMatchObject({ disposition: "created" });
    await expect(f.store.mirrorTenantBackupCatalogEvent(mirrorInput))
      .resolves.toMatchObject({ disposition: "exact_replay" });
    expect(await f.store.getTenantBackupRuntimeReservation(reservation.restoreRunId))
      .toMatchObject({ phase: "reserved" });
    await expect(f.store.listRecoverableTenantBackups({ limit: 10 })).resolves.toEqual([entry]);

    await expect(f.store.abortTenantRestoreReplay(reservation.restoreRunId)).resolves.toBe(true);
    await expect(f.store.resolveTenantBackupRuntimeReservation(resolution)).resolves.toMatchObject({
      disposition: "exact_replay",
      value: { phase: "aborted" },
    });
  });

  it("preflights a fresh restore, permits only the exact active reservation, and rejects used identities", async () => {
    const f = await fixture();
    const entry = await publishBackup(
      f,
      newTenantBackupId(),
      "preflight-backup",
      1,
      EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
    );
    const input = restoreInput(f, entry, "preflight-epoch", 2, entry.catalogEventRootSha256);
    const preflight = {
      backupId: input.backupId,
      restoreRunId: input.restoreRunId,
      runtimeEpochSha256: input.runtimeEpochSha256,
    };

    await expect(f.store.preflightTenantRestoreReplayFromBackup(preflight)).resolves.toEqual(entry);
    const prepared = await f.store.prepareTenantRestoreReplayFromBackup(input);
    await expect(f.store.preflightTenantRestoreReplayFromBackup(preflight)).resolves.toEqual(entry);
    await expect(f.store.preflightTenantRestoreReplayFromBackup({
      backupId: entry.backupId,
      restoreRunId: `restore_${randomUUID()}`,
      runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("blocked-by-active-reservation"),
    })).rejects.toMatchObject({ reason: "restore_reservation_active" });

    await expect(f.store.abortTenantRestoreReplay(input.restoreRunId)).resolves.toBe(true);
    const reservation = prepared.value.reservation;
    const resolutionOperationSha256 = tenantBackupReservationResolutionOperationSha256({
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "aborted",
    });
    const resolutionReceiptSha256 = tenantBackupResolutionReceiptSha256({
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "aborted",
    });
    await f.store.resolveTenantBackupRuntimeReservation({
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "aborted",
      resolutionOperationSha256,
      resolutionReceiptSha256,
      ...eventProof(
        3,
        reservation.catalogEventRootSha256,
        "restore_resolved",
        resolutionOperationSha256,
        resolutionReceiptSha256,
      ),
    });

    await expect(f.store.preflightTenantRestoreReplayFromBackup({
      ...preflight,
      runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("different-epoch-for-used-run"),
    })).rejects.toBeInstanceOf(TenantBackupCatalogConflictError);
    await expect(f.store.preflightTenantRestoreReplayFromBackup({
      ...preflight,
      restoreRunId: `restore_${randomUUID()}`,
    })).rejects.toBeInstanceOf(TenantBackupCatalogConflictError);
  });

  it("serializes competing reservations and permanently burns a runtime epoch", async () => {
    const f = await fixture();
    const first = await publishBackup(
      f,
      newTenantBackupId(),
      "first-concurrent",
      1,
      EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
    );
    const second = await publishBackup(
      f,
      newTenantBackupId(),
      "second-concurrent",
      2,
      first.catalogEventRootSha256,
    );
    const epochLabel = "never-reused-restore-epoch";
    const firstInput = restoreInput(f, first, epochLabel, 3, second.catalogEventRootSha256);
    const secondInput = restoreInput(f, second, epochLabel, 3, second.catalogEventRootSha256);
    const results = await Promise.allSettled([
      f.store.prepareTenantRestoreReplayFromBackup(firstInput),
      f.store.prepareTenantRestoreReplayFromBackup(secondInput),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const winner = results.find((result) => result.status === "fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("no reservation winner");
    await f.store.abortTenantRestoreReplay(winner.value.value.replayRun.restoreRunId);
    const reservation = winner.value.value.reservation;
    const resolutionOperationSha256 = tenantBackupReservationResolutionOperationSha256({
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "aborted",
    });
    const resolutionReceiptSha256 = tenantBackupResolutionReceiptSha256({
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "aborted",
    });
    const resolution = {
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "aborted" as const,
      resolutionOperationSha256,
      resolutionReceiptSha256,
      ...eventProof(
        4,
        reservation.catalogEventRootSha256,
        "restore_resolved",
        resolutionOperationSha256,
        resolutionReceiptSha256,
      ),
    };
    expect((await f.store.resolveTenantBackupRuntimeReservation(resolution)).disposition)
      .toBe("created");
    expect((await f.store.resolveTenantBackupRuntimeReservation(resolution)).disposition)
      .toBe("exact_replay");

    const loserEntry = winner.value.value.binding.backupId === first.backupId ? second : first;
    const reusedEpoch = restoreInput(f, loserEntry, epochLabel, 5,
      resolution.catalogEventRootSha256);
    await expect(f.store.prepareTenantRestoreReplayFromBackup(reusedEpoch))
      .rejects.toBeInstanceOf(TenantBackupCatalogConflictError);
  });

  it("requires retention, a physical ACK, no reservation, and one remaining backup", async () => {
    const f = await fixture(1);
    const first = await publishBackup(
      f,
      newTenantBackupId(),
      "first-eviction",
      1,
      EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
    );
    const second = await publishBackup(
      f,
      newTenantBackupId(),
      "second-eviction",
      2,
      first.catalogEventRootSha256,
    );
    await expect(f.store.prepareTenantBackupEviction({
      evictionId: newTenantBackupEvictionId(),
      backupId: first.backupId,
    })).rejects.toMatchObject({ reason: "retention_not_elapsed" });
    f.clock.value = first.retentionUntilDbMs;

    const restore = restoreInput(f, first, "eviction-reservation", 3,
      second.catalogEventRootSha256);
    const prepared = await f.store.prepareTenantRestoreReplayFromBackup(restore);
    await expect(f.store.prepareTenantBackupEviction({
      evictionId: newTenantBackupEvictionId(),
      backupId: first.backupId,
    })).rejects.toMatchObject({ reason: "restore_reservation_active" });
    await f.store.abortTenantRestoreReplay(restore.restoreRunId);
    const resolutionOperationSha256 = tenantBackupReservationResolutionOperationSha256({
      restoreRunId: restore.restoreRunId,
      reservationReceiptSha256: prepared.value.reservation.reservationReceiptSha256,
      phase: "aborted",
    });
    const resolutionReceiptSha256 = tenantBackupResolutionReceiptSha256({
      restoreRunId: restore.restoreRunId,
      reservationReceiptSha256: prepared.value.reservation.reservationReceiptSha256,
      phase: "aborted",
    });
    const resolved = {
      restoreRunId: restore.restoreRunId,
      reservationReceiptSha256: prepared.value.reservation.reservationReceiptSha256,
      phase: "aborted" as const,
      resolutionOperationSha256,
      resolutionReceiptSha256,
      ...eventProof(
        4,
        restore.reservation.catalogEventRootSha256,
        "restore_resolved",
        resolutionOperationSha256,
        resolutionReceiptSha256,
      ),
    };
    await f.store.resolveTenantBackupRuntimeReservation(resolved);

    const plan = await f.store.prepareTenantBackupEviction({
      evictionId: newTenantBackupEvictionId(),
      backupId: first.backupId,
    });
    const ack = evictionAck(f, plan, 5, resolved.catalogEventRootSha256);
    f.store.tenantBackupCatalogEvictions = new FailOnceMap();
    await expect(f.store.recordTenantBackupCatalogEviction({ plan, acknowledgement: ack }))
      .rejects.toThrow("injected backup catalog map failure");
    expect(f.store.tenantBackupCatalogEvictions.size).toBe(0);
    expect(await f.store.listRecoverableTenantBackups({ limit: 10 })).toHaveLength(2);

    const terminal = await f.store.recordTenantBackupCatalogEviction({
      plan,
      acknowledgement: ack,
    });
    expect(terminal).toMatchObject({
      disposition: "created",
      value: {
        backupId: first.backupId,
        observedAbsent: true,
        externalTombstoneSha256: ack.externalTombstoneSha256,
      },
    });
    expect((await f.store.recordTenantBackupCatalogEviction({
      plan,
      acknowledgement: ack,
    })).disposition).toBe("exact_replay");
    await expect(f.store.recordTenantBackupCatalogEviction({
      plan,
      acknowledgement: {
        ...ack,
        catalogNamespaceSha256: sha256("wrong-exact-replay-namespace"),
      },
    })).rejects.toBeInstanceOf(TenantBackupCatalogConflictError);
    await expect(f.store.recordTenantBackupCatalogEviction({
      plan,
      acknowledgement: {
        ...ack,
        catalogTargetSha256: sha256("wrong-exact-replay-target"),
      },
    })).rejects.toBeInstanceOf(TenantBackupCatalogConflictError);
    expect(await f.store.listRecoverableTenantBackups({ limit: 10 }))
      .toEqual([second]);
    await expect(f.store.prepareTenantBackupEviction({
      evictionId: newTenantBackupEvictionId(),
      backupId: second.backupId,
    })).rejects.toMatchObject({ reason: "minimum_recoverable_backups" });
  });

  it("projects a mirrored external eviction before exact local record replay", async () => {
    const f = await fixture(1);
    const first = await publishBackup(
      f,
      newTenantBackupId(),
      "mirror-first-eviction-a",
      1,
      EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
    );
    const second = await publishBackup(
      f,
      newTenantBackupId(),
      "mirror-first-eviction-b",
      2,
      first.catalogEventRootSha256,
    );
    f.clock.value = first.retentionUntilDbMs;
    const plan = await f.store.prepareTenantBackupEviction({
      evictionId: newTenantBackupEvictionId(),
      backupId: first.backupId,
    });
    const acknowledgement = evictionAck(f, plan, 3, second.catalogEventRootSha256);

    await expect(f.store.mirrorTenantBackupCatalogEvent({
      adapterProtocol: f.control.adapterProtocol,
      catalogNamespaceSha256: f.control.catalogNamespaceSha256,
      catalogTargetSha256: f.control.catalogTargetSha256,
      failureDomainSha256: f.control.failureDomainSha256,
      event: { eventType: "backup_evicted", result: acknowledgement },
    })).resolves.toMatchObject({ disposition: "created" });
    const projected = await f.store.getTenantBackupCatalogEviction(first.backupId);
    expect(projected).toMatchObject({
      backupId: first.backupId,
      evictionId: plan.evictionId,
      planSha256: plan.planSha256,
      acknowledgementReceiptSha256: acknowledgement.acknowledgementReceiptSha256,
    });
    await expect(f.store.recordTenantBackupCatalogEviction({ plan, acknowledgement }))
      .resolves.toEqual({ disposition: "exact_replay", value: projected });
    expect(await f.store.listRecoverableTenantBackups({ limit: 10 })).toEqual([second]);
  });
});
