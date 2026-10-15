import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemorySessionStore, emptyTenantBackupCatalogHead, EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  type TenantRestoreJournalRemoteHead, type TenantTelemetryCaptureBackupSourceMaintenance,
} from "@agent-service/store";
import { createTenantBackupCatalogAdapter, loadTenantBackupCatalogConfig } from "../src/tenant-backup-catalog-config.js";
import { createTenantRestoreJournalSourceObservationAdapters, loadTenantRestoreJournalConfig,
  loadTenantRestoreJournalSourceObservationConfig } from "../src/tenant-restore-journal-config.js";
import { assertMySqlBackupArtifactSourceObserved, createMySqlBackupArtifactSourceObserver } from "../src/mysql-backup-artifact-source-observer.js";

// Real codecs/configuration/class assembly, but explicitly stubbed adapter I/O
// and a closed Memory delegate. NOT a SQL source-facade, remote GET or restore
// ancestry proof; the independent MySQL/MinIO vertical must prove those.
const resources: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(resources.splice(0).map((resource) => resource.close())); });
const env = {
  RESTORE_JOURNAL_ADAPTER: "s3", RESTORE_JOURNAL_DATABASE_NAMESPACE_ID: "source-observer-db",
  RESTORE_JOURNAL_RUNTIME_EPOCH_ID: "source-observer-primary", RESTORE_JOURNAL_NAMESPACE_ID: "source-observer-journal",
  RESTORE_JOURNAL_FAILURE_DOMAIN_ID: "source-observer-journal-domain", RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK: "1",
  RESTORE_JOURNAL_S3_BUCKET: "source-observer-journal", RESTORE_JOURNAL_S3_ENDPOINT: "http://127.0.0.1:9000",
  BACKUP_CATALOG_ADAPTER: "s3", BACKUP_CATALOG_DATABASE_NAMESPACE_ID: "source-observer-db",
  BACKUP_CATALOG_NAMESPACE_ID: "source-observer-catalog", BACKUP_CATALOG_FAILURE_DOMAIN_ID: "source-observer-catalog-domain",
  BACKUP_CATALOG_INDEPENDENT_FAILURE_DOMAIN_ACK: "1", BACKUP_CATALOG_S3_BUCKET: "source-observer-catalog",
  BACKUP_CATALOG_S3_ENDPOINT: "http://127.0.0.1:9000", BACKUP_CATALOG_MINIMUM_RETENTION_MS: "0",
  BACKUP_CATALOG_MINIMUM_RECOVERABLE_BACKUPS: "1",
} satisfies NodeJS.ProcessEnv;

function closedSourceDouble(store: MemorySessionStore): TenantTelemetryCaptureBackupSourceMaintenance {
  return Object.freeze({
    sealTenantTelemetryCaptureBackupCheckpoint: store.sealTenantTelemetryCaptureBackupCheckpoint.bind(store),
    getTenantTelemetryCaptureBackupCheckpoint: store.getTenantTelemetryCaptureBackupCheckpoint.bind(store),
    assertTenantTelemetryCaptureBackupCheckpointUnchanged: store.assertTenantTelemetryCaptureBackupCheckpointUnchanged.bind(store),
    getTenantBackupCatalogControl: store.getTenantBackupCatalogControl.bind(store),
    createTenantBackupSnapshotAnchor: store.createTenantBackupSnapshotAnchor.bind(store),
    getTenantBackupSnapshotAnchor: store.getTenantBackupSnapshotAnchor.bind(store),
    recordTenantBackupCatalogAvailability: store.recordTenantBackupCatalogAvailability.bind(store),
    mirrorTenantBackupCatalogEvent: store.mirrorTenantBackupCatalogEvent.bind(store),
    getTenantBackupCatalogEntry: store.getTenantBackupCatalogEntry.bind(store), listRecoverableTenantBackups: store.listRecoverableTenantBackups.bind(store),
    preflightTenantRestoreReplayFromBackup: store.preflightTenantRestoreReplayFromBackup.bind(store),
    prepareTenantRestoreReplayFromBackup: store.prepareTenantRestoreReplayFromBackup.bind(store),
    getTenantRestoreJournalControl: store.getTenantRestoreJournalControl.bind(store),
    getTenantRestoreJournalControlTargets: store.getTenantRestoreJournalControlTargets.bind(store),
    getTenantRestoreRuntimeControl: store.getTenantRestoreRuntimeControl.bind(store), getTenantRestoreRuntimeHeads: store.getTenantRestoreRuntimeHeads.bind(store),
    getBlobStorageControl: store.getBlobStorageControl.bind(store), close: store.close.bind(store),
  });
}

async function fixture() {
  const runtimeConfig = loadTenantRestoreJournalConfig(env, { production: false, store: "mysql" })!;
  const config = loadTenantRestoreJournalSourceObservationConfig(env, { production: false, store: "mysql" }, runtimeConfig.runtimeEpochSha256)!;
  const catalogConfig = loadTenantBackupCatalogConfig(env, { production: false, store: "mysql", requireRetentionPolicy: true })!;
  const catalog = createTenantBackupCatalogAdapter(catalogConfig);
  const journals = createTenantRestoreJournalSourceObservationAdapters(config);
  const journal = journals[0]!; resources.push(catalog, ...journals);
  const head: TenantRestoreJournalRemoteHead = { scope: "tenant-restore-journal-remote-head-v1", protocol: "tenant-restore-journal-v1",
    adapterProtocol: journal.adapterProtocol, journalNamespaceSha256: journal.journalNamespaceSha256, targetSha256: journal.targetSha256,
    logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256, remoteSequence: 0, headRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256 };
  const readHead = vi.spyOn(journal, "readHead").mockResolvedValue(head);
  const scan = vi.spyOn(journal, "scanRecords").mockRejectedValue(new Error("unexpected-empty-prefix-scan"));
  const journalStartup = vi.spyOn(journal, "validateStartup").mockRejectedValue(new Error("observation-must-not-probe"));
  const publish = vi.spyOn(journal, "publishRecord").mockRejectedValue(new Error("observation-must-not-publish"));
  const catalogHead = emptyTenantBackupCatalogHead({ adapterProtocol: catalog.adapterProtocol,
    catalogNamespaceSha256: catalog.catalogNamespaceSha256, catalogTargetSha256: catalog.catalogTargetSha256,
    failureDomainSha256: catalog.failureDomainSha256 });
  const observe = vi.spyOn(catalog, "readHeadForBackupSourceObservation").mockResolvedValue(catalogHead);
  const ordinaryHead = vi.spyOn(catalog, "readHead").mockRejectedValue(new Error("observation-must-not-help-cas-head"));
  const catalogStartup = vi.spyOn(catalog, "validateStartup").mockRejectedValue(new Error("observation-must-not-probe"));
  const reserve = vi.spyOn(catalog, "reserveRestore").mockRejectedValue(new Error("observation-must-not-reserve"));
  const store = new MemorySessionStore({ now: () => 1_000 }, { tenantBackupSchemaMigrationNames: ["source-observer-fixture"] });
  resources.push(store);
  const control = await store.activateTenantRestoreJournalControl({ adapterProtocol: config.adapterProtocol,
    journalNamespaceSha256: config.journalNamespaceSha256, logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
    runtimeEpochSha256: config.sourceRuntimeEpochSha256, targets: config.targets.map((target) => target.descriptor), observedHeads: [{
      ...config.targets[0].descriptor, logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
      sealedRemoteSequence: 0, sealedHeadRootSha256: head.headRootSha256 }] });
  await store.activateBlobStorageControl({ expectedControlGeneration: 0, storageBackend: "memory-v1", namespaceSha256: "a".repeat(64) });
  const catalogControl = await store.activateTenantBackupCatalogControl({ expectedControlGeneration: 0,
    adapterProtocol: catalogConfig.adapterProtocol, catalogNamespaceSha256: catalogConfig.catalogNamespaceSha256,
    catalogTargetSha256: catalogConfig.catalogTargetSha256, failureDomainSha256: catalogConfig.failureDomainSha256,
    logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256, journalControlEvidenceSha256: control.evidenceSha256,
    retentionPolicySha256: catalogConfig.retentionPolicySha256!, minimumRetentionMs: catalogConfig.minimumRetentionMs!,
    minimumRecoverableBackups: catalogConfig.minimumRecoverableBackups! });
  const anchored = await store.createTenantBackupSnapshotAnchor({ backupId: "backup_00000000-0000-4000-8000-000000000001",
    controlEvidenceSha256: catalogControl.value.evidenceSha256 });
  const runtimeRead = vi.spyOn(store, "getTenantRestoreRuntimeControl");
  const runtimeHeadsRead = vi.spyOn(store, "getTenantRestoreRuntimeHeads");
  const source = closedSourceDouble(store), stepCalls = vi.fn(() => {});
  async function step<T>(operation: () => Promise<T>): Promise<T> {
    stepCalls();
    return operation();
  }
  const observer = createMySqlBackupArtifactSourceObserver({ store: source, config, catalog, journals, step });
  return { observer, source, store, config, catalog, journals, head, catalogHead, anchor: anchored.value,
    readHead, scan, observe, ordinaryHead, journalStartup, publish, catalogStartup, reserve, stepCalls,
    runtimeRead, runtimeHeadsRead };
}

type ObserverStep = Parameters<typeof createMySqlBackupArtifactSourceObserver>[0]["step"];
function withStep(h: Awaited<ReturnType<typeof fixture>>, step: ObserverStep) {
  return createMySqlBackupArtifactSourceObserver({ store: h.source, config: h.config,
    catalog: h.catalog, journals: h.journals, step });
}

describe("branded artifact source observer (pure I/O doubles)", () => {
  it("re-reads actual source and both fresh heads without startup, publish, reservation or ordinary catalog-head fallback", async () => {
    const h = await fixture(); await assertMySqlBackupArtifactSourceObserved(h.observer, h.source, h.anchor);
    expect(h.observe).toHaveBeenCalledTimes(2); expect(h.readHead).toHaveBeenCalledTimes(2); expect(h.stepCalls).toHaveBeenCalled();
    expect(h.ordinaryHead).not.toHaveBeenCalled(); expect(h.journalStartup).not.toHaveBeenCalled(); expect(h.catalogStartup).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled(); expect(h.reserve).not.toHaveBeenCalled(); expect(h.scan).not.toHaveBeenCalled();
    expect(Object.keys(h.observer)).toEqual(["purpose"]); expect(Object.isFrozen(h.observer)).toBe(true);
  });

  it("rejects a hostile no-op step returning a sealed value without executing the actual read", async () => {
    const h = await fixture(), sealed = await h.store.getTenantRestoreRuntimeControl(); h.runtimeRead.mockClear();
    // Deliberately model an external JS caller lying about its generic result.
    // This local hostile-wrapper cast is not a product/source authority cast.
    async function noOp<T>(_operation: () => Promise<T>): Promise<T> { return sealed as T; }
    await expect(assertMySqlBackupArtifactSourceObserved(withStep(h, noOp), h.source, h.anchor))
      .rejects.toHaveProperty("code", "capture_source_observation_invalid");
    expect(h.runtimeRead).not.toHaveBeenCalled(); expect(h.runtimeHeadsRead).not.toHaveBeenCalled();
    expect(h.observe).not.toHaveBeenCalled(); expect(h.readHead).not.toHaveBeenCalled();
  });

  it("uses only actual method results even when every completed step returns a forged replacement", async () => {
    const h = await fixture(), sealed = Object.freeze({ hostileReplacement: true });
    async function replace<T>(operation: () => Promise<T>): Promise<T> { await operation(); return sealed as T; }
    await expect(assertMySqlBackupArtifactSourceObserved(withStep(h, replace), h.source, h.anchor)).resolves.toBeUndefined();
    expect(h.runtimeRead).toHaveBeenCalledTimes(2); expect(h.runtimeHeadsRead).toHaveBeenCalledTimes(2);
    expect(h.observe).toHaveBeenCalledTimes(2); expect(h.readHead).toHaveBeenCalledTimes(2);
    expect(h.publish).not.toHaveBeenCalled(); expect(h.reserve).not.toHaveBeenCalled();
  });

  it("does not let a wrapper mutate a newly read authority head in place into a sealed older value", async () => {
    const h = await fixture();
    const actualHead = { ...h.catalogHead, catalogSequence: 1, catalogEventRootSha256: "e".repeat(64) };
    h.observe.mockResolvedValueOnce(actualHead);
    async function mutate<T>(operation: () => Promise<T>): Promise<T> {
      const value = await operation();
      if (value !== null && typeof value === "object" && Reflect.has(value, "catalogSequence")
        && Reflect.has(value, "catalogEventRootSha256")) {
        Object.assign(value, h.catalogHead);
      }
      return value;
    }
    await expect(assertMySqlBackupArtifactSourceObserved(withStep(h, mutate), h.source, h.anchor))
      .rejects.toHaveProperty("code", "capture_source_observation_invalid");
    expect(actualHead).toEqual(h.catalogHead); // The attack really changed the exposed value.
    expect(h.runtimeRead).toHaveBeenCalledOnce(); expect(h.runtimeHeadsRead).toHaveBeenCalledOnce();
    expect(h.observe).toHaveBeenCalledOnce(); expect(h.readHead).not.toHaveBeenCalled();
  });

  it("does not let a step swallow an actual read rejection and replace it with sealed evidence", async () => {
    const h = await fixture(), sealed = Object.freeze({ hostileReplacement: true });
    const actualFailure = new Error("closed_actual_source_read_failed");
    h.runtimeRead.mockRejectedValueOnce(actualFailure);
    async function swallow<T>(operation: () => Promise<T>): Promise<T> {
      try { return await operation(); } catch { return sealed as T; }
    }
    await expect(assertMySqlBackupArtifactSourceObserved(withStep(h, swallow), h.source, h.anchor)).rejects.toBe(actualFailure);
    expect(h.runtimeRead).toHaveBeenCalledOnce(); expect(h.runtimeHeadsRead).not.toHaveBeenCalled();
    expect(h.observe).not.toHaveBeenCalled(); expect(h.readHead).not.toHaveBeenCalled();
  });

  it("rejects duplicate callback invocation even if its rejection is swallowed, and executes the actual method once", async () => {
    const h = await fixture();
    async function duplicate<T>(operation: () => Promise<T>): Promise<T> {
      const value = await operation(); await operation().catch(() => {}); return value;
    }
    await expect(assertMySqlBackupArtifactSourceObserved(withStep(h, duplicate), h.source, h.anchor))
      .rejects.toHaveProperty("code", "capture_source_observation_invalid");
    expect(h.runtimeRead).toHaveBeenCalledOnce(); expect(h.runtimeHeadsRead).not.toHaveBeenCalled();
    expect(h.observe).not.toHaveBeenCalled();
  });

  it("rejects a step that returns before an actual pending read finishes without waiting for that unbounded read", async () => {
    const h = await fixture(), sealed = await h.store.getTenantRestoreRuntimeControl(); h.runtimeRead.mockClear();
    const deferred: { release?: (value: typeof sealed) => void } = {};
    const pending = new Promise<typeof sealed>((resolve) => { deferred.release = resolve; });
    h.runtimeRead.mockImplementationOnce(() => pending);
    async function early<T>(operation: () => Promise<T>): Promise<T> { void operation(); return sealed as T; }
    try {
      await expect(assertMySqlBackupArtifactSourceObserved(withStep(h, early), h.source, h.anchor))
        .rejects.toHaveProperty("code", "capture_source_observation_invalid");
      expect(h.runtimeRead).toHaveBeenCalledOnce(); expect(h.runtimeHeadsRead).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
    } finally { deferred.release?.(sealed); await pending; }
  });

  it("closes the callback after a no-call step returns so a later callback cannot start I/O", async () => {
    const h = await fixture(), sealed = Object.freeze({ hostileReplacement: true });
    const deferred: { late?: () => Promise<unknown> } = {};
    async function defer<T>(operation: () => Promise<T>): Promise<T> { deferred.late = operation; return sealed as T; }
    await expect(assertMySqlBackupArtifactSourceObserved(withStep(h, defer), h.source, h.anchor))
      .rejects.toHaveProperty("code", "capture_source_observation_invalid");
    if (!deferred.late) throw new Error("late_observer_callback_missing");
    await expect(deferred.late()).rejects.toHaveProperty("code", "capture_source_observation_invalid");
    expect(h.runtimeRead).not.toHaveBeenCalled(); expect(h.observe).not.toHaveBeenCalled();
  });

  it.each(["before", "after"] as const)("preserves a budget/ownership rejection %s actual execution", async (boundary) => {
    const h = await fixture(), denied = new Error("closed_budget_or_ownership_rejected");
    async function budget<T>(operation: () => Promise<T>): Promise<T> {
      if (boundary === "after") await operation();
      throw denied;
    }
    await expect(assertMySqlBackupArtifactSourceObserved(withStep(h, budget), h.source, h.anchor)).rejects.toBe(denied);
    expect(h.runtimeRead).toHaveBeenCalledTimes(boundary === "after" ? 1 : 0);
    expect(h.runtimeHeadsRead).not.toHaveBeenCalled(); expect(h.observe).not.toHaveBeenCalled();
  });

  it("rejects missing, forged and cross-store observer capabilities before source/remote reads", async () => {
    const h = await fixture();
    for (const observer of [undefined, Object.freeze({ purpose: "mysql-backup-source-observer-v1" as const })]) {
      await expect(assertMySqlBackupArtifactSourceObserved(observer, h.source, h.anchor)).rejects.toHaveProperty("code", "capture_source_observation_invalid");
    }
    await expect(assertMySqlBackupArtifactSourceObserved(h.observer, closedSourceDouble(h.store), h.anchor)).rejects.toHaveProperty("code", "capture_source_observation_invalid");
    expect(h.observe).not.toHaveBeenCalled(); expect(h.stepCalls).not.toHaveBeenCalled();
  });

  it("does not accept an observation-config digest as proof of the current actual source epoch", async () => {
    const h = await fixture();
    const wrong = createMySqlBackupArtifactSourceObserver({ store: h.source, config: { ...h.config, sourceRuntimeEpochSha256: "b".repeat(64) },
      catalog: h.catalog, journals: h.journals, step: async (operation) => operation() });
    await expect(assertMySqlBackupArtifactSourceObserved(wrong, h.source, h.anchor)).rejects.toHaveProperty("code", "capture_source_observation_invalid");
    expect(h.observe).not.toHaveBeenCalled(); expect(h.readHead).not.toHaveBeenCalled();
  });

  it("rejects a missing/pending catalog authority instead of invoking the ordinary recovering read", async () => {
    const h = await fixture(); h.observe.mockRejectedValueOnce(new Error("closed-missing-or-pending-head"));
    await expect(assertMySqlBackupArtifactSourceObserved(h.observer, h.source, h.anchor)).rejects.toThrow("closed-missing-or-pending-head");
    expect(h.ordinaryHead).not.toHaveBeenCalled(); expect(h.readHead).not.toHaveBeenCalled();
  });

  it.each(["journal", "catalog"] as const)("rejects %s drift between sealed-chain observation and its final fresh read", async (which) => {
    const h = await fixture();
    if (which === "journal") h.readHead.mockResolvedValueOnce(h.head).mockResolvedValueOnce({ ...h.head, remoteSequence: 1, headRootSha256: "c".repeat(64) });
    else h.observe.mockResolvedValueOnce(h.catalogHead).mockResolvedValueOnce({ ...h.catalogHead, catalogSequence: 1, catalogEventRootSha256: "d".repeat(64) });
    await expect(assertMySqlBackupArtifactSourceObserved(h.observer, h.source, h.anchor)).rejects.toHaveProperty("code", "capture_source_observation_invalid");
    expect(h.publish).not.toHaveBeenCalled(); expect(h.reserve).not.toHaveBeenCalled();
  });
});
