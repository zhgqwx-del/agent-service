import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MemorySessionStore,
  MemoryTenantBackupCatalogAdapter,
  MemoryTenantRestoreJournalAdapter,
  tenantRestoreJournalTargetRootSha256,
  tenantRestoreLogicalDatabaseNamespaceSha256,
  tenantRestoreRuntimeEpochSha256,
  type TenantBackupCatalogAdapter,
  type TenantRestoreJournalAdapter,
  type TenantRestoreJournalTargetDescriptor,
} from "@agent-service/store";
import {
  formatBackupCatalogCliError,
  runBackupCatalogCli,
  type BackupCatalogCliDependencies,
} from "../src/backup-catalog-cli.js";
import type { TenantBackupCatalogRuntimeConfig } from
  "../src/tenant-backup-catalog-config.js";
import type { TenantRestoreJournalRuntimeConfig } from
  "../src/tenant-restore-journal-config.js";

const MYSQL_URL = "mysql://fixture@127.0.0.1:3306/agent_service_test";
const PRIMARY_EPOCH_ID = "backup-cli-primary-epoch-v1";
const RESTORE_EPOCH_ID = "backup-cli-restore-epoch-v2";
const BACKUP_ID_1 = "backup_00000000-0000-4000-8000-000000000001";
const BACKUP_ID_2 = "backup_00000000-0000-4000-8000-000000000002";
const BACKUP_ID_3 = "backup_00000000-0000-4000-8000-000000000003";
const RESTORE_RUN_ID = "restore_00000000-0000-4000-8000-000000000001";
const EVICTION_ID = "backup_evict_00000000-0000-4000-8000-000000000001";
const RESPONSE_LOSS_MARKER = "private-response-loss-marker";
const LOGICAL_DATABASE_NAMESPACE_SHA256 = tenantRestoreLogicalDatabaseNamespaceSha256(
  "backup-cli-database-v1",
);

function sha256(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

class TestClock {
  constructor(public value = 10_000) {}
  now(): number { return this.value; }
}

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { MYSQL_URL, ...extra };
}

function catalogEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return baseEnv({ BACKUP_CATALOG_ADAPTER: "s3", ...extra });
}

function activateEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return catalogEnv({
    BACKUP_CATALOG_ACTIVATION_ACK: "1",
    RESTORE_FLEET_STOPPED_ACK: "1",
    ...extra,
  });
}

function publishValues(label: string) {
  return {
    SOURCE_SNAPSHOT_SHA256: sha256(`${label}-source-snapshot`),
    SOURCE_BACKUP_SHA256: sha256(`${label}-source-backup`),
    BACKUP_ARTIFACT_MANIFEST_SHA256: sha256(`${label}-artifact-manifest`),
    BACKUP_PROVIDER_EVIDENCE_SHA256: sha256(`${label}-provider-evidence`),
  };
}

function publishEnv(
  backupId: string,
  label: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return catalogEnv({ BACKUP_ID: backupId, ...publishValues(label), ...extra });
}

function prepareRestoreEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return catalogEnv({
    BACKUP_ID: BACKUP_ID_1,
    RESTORE_RUN_ID,
    BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID,
    SOURCE_BACKUP_SHA256: publishValues("backup-one").SOURCE_BACKUP_SHA256,
    RESTORE_FLEET_STOPPED_ACK: "1",
    ...extra,
  });
}

interface HarnessOptions {
  minimumRetentionMs?: number;
  minimumRecoverableBackups?: number;
  loseFirstCatalogEventResponse?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const clock = new TestClock();
  const store = new MemorySessionStore(clock, {
    tenantBackupSchemaMigrationNames: ["0031-backup-cli-fixture"],
  });
  const storeClose = vi.spyOn(store, "close");
  let loseCatalogEventResponse = options.loseFirstCatalogEventResponse ?? false;
  const catalogDelegate = new MemoryTenantBackupCatalogAdapter({
    nonProductionFixture: true,
    namespaceId: "backup-cli-catalog-v1",
    targetId: "backup-cli-catalog-target-v1",
    failureDomainId: "backup-cli-independent-fixture-v1",
    afterEventCommit: () => {
      if (loseCatalogEventResponse) {
        loseCatalogEventResponse = false;
        throw new Error(RESPONSE_LOSS_MARKER);
      }
    },
  });
  const catalogAdapter: TenantBackupCatalogAdapter = {
    adapterProtocol: catalogDelegate.adapterProtocol,
    catalogNamespaceSha256: catalogDelegate.catalogNamespaceSha256,
    catalogTargetSha256: catalogDelegate.catalogTargetSha256,
    failureDomainSha256: catalogDelegate.failureDomainSha256,
    validateStartup: vi.fn(() => catalogDelegate.validateStartup()),
    publishAvailability: (input) => catalogDelegate.publishAvailability(input),
    inspectAvailability: (backupId) => catalogDelegate.inspectAvailability(backupId),
    reserveRestore: (input) => catalogDelegate.reserveRestore(input),
    resolveRestore: (input) => catalogDelegate.resolveRestore(input),
    recordEviction: (input) => catalogDelegate.recordEviction(input),
    readHead: () => catalogDelegate.readHead(),
    scanEvents: (input) => catalogDelegate.scanEvents(input),
    // Each CLI invocation releases its client; the delegate models the persistent remote target.
    close: vi.fn(async () => {}),
  };
  const catalogConfig = {
    adapterProtocol: catalogAdapter.adapterProtocol,
    catalogNamespaceSha256: catalogAdapter.catalogNamespaceSha256,
    catalogTargetSha256: catalogAdapter.catalogTargetSha256,
    failureDomainSha256: catalogAdapter.failureDomainSha256,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    retentionPolicySha256: sha256("backup-cli-retention-policy"),
    minimumRetentionMs: options.minimumRetentionMs ?? 100,
    minimumRecoverableBackups: options.minimumRecoverableBackups ?? 1,
    options: {},
  } as unknown as TenantBackupCatalogRuntimeConfig;

  const journalDelegate = new MemoryTenantRestoreJournalAdapter({
    nonProductionFixture: true,
    namespaceId: "backup-cli-journal-v1",
    failureDomainId: "backup-cli-journal-independent-fixture-v1",
    targetId: "backup-cli-journal-target-v1",
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
  });
  const journalAdapter: TenantRestoreJournalAdapter & {
    validateStartup(): Promise<void>;
  } = {
    adapterProtocol: journalDelegate.adapterProtocol,
    journalNamespaceSha256: journalDelegate.journalNamespaceSha256,
    targetSha256: journalDelegate.targetSha256,
    failureDomainSha256: journalDelegate.failureDomainSha256,
    logicalDatabaseNamespaceSha256: journalDelegate.logicalDatabaseNamespaceSha256,
    validateStartup: vi.fn(async () => {}),
    publishRecord: (record) => journalDelegate.publishRecord(record),
    inspectRecord: (record) => journalDelegate.inspectRecord(record),
    readHead: () => journalDelegate.readHead(),
    scanRecords: (input) => journalDelegate.scanRecords(input),
    close: vi.fn(async () => {}),
  };
  const descriptor: TenantRestoreJournalTargetDescriptor = {
    targetOrdinal: 0,
    targetSha256: journalAdapter.targetSha256,
    failureDomainSha256: journalAdapter.failureDomainSha256,
    adapterProtocol: journalAdapter.adapterProtocol,
    journalNamespaceSha256: journalAdapter.journalNamespaceSha256,
  };
  const journalConfig = (epochId: string): TenantRestoreJournalRuntimeConfig => ({
    adapterProtocol: journalAdapter.adapterProtocol,
    journalNamespaceSha256: journalAdapter.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    runtimeEpochSha256: tenantRestoreRuntimeEpochSha256(epochId),
    targetRootSha256: tenantRestoreJournalTargetRootSha256([descriptor]),
    targets: [{ descriptor, options: {} }],
  } as unknown as TenantRestoreJournalRuntimeConfig);

  const output: string[] = [];
  const connectStore = vi.fn(async () => store);
  const loadCatalogConfig = vi.fn(() => catalogConfig);
  const createCatalogAdapter = vi.fn(() => catalogAdapter);
  const loadJournalConfig = vi.fn((env: NodeJS.ProcessEnv) => journalConfig(
    env.RESTORE_JOURNAL_RUNTIME_EPOCH_ID ?? PRIMARY_EPOCH_ID,
  ));
  const createJournalAdapters = vi.fn(() => [journalAdapter]);
  const dependencies: BackupCatalogCliDependencies = {
    connectStore: connectStore as BackupCatalogCliDependencies["connectStore"],
    loadCatalogConfig,
    createCatalogAdapter:
      createCatalogAdapter as BackupCatalogCliDependencies["createCatalogAdapter"],
    loadJournalConfig,
    createJournalAdapters:
      createJournalAdapters as BackupCatalogCliDependencies["createJournalAdapters"],
    writeLine: (line) => output.push(line),
  };
  return {
    clock,
    store,
    storeClose,
    catalogDelegate,
    catalogAdapter,
    catalogConfig,
    journalDelegate,
    journalAdapter,
    descriptor,
    output,
    connectStore,
    loadCatalogConfig,
    createCatalogAdapter,
    loadJournalConfig,
    createJournalAdapters,
    dependencies,
  };
}

type Harness = ReturnType<typeof createHarness>;

async function initializePrimary(state: Harness): Promise<void> {
  const head = await state.journalDelegate.readHead();
  await state.store.activateTenantRestoreJournalControl({
    adapterProtocol: state.journalAdapter.adapterProtocol,
    journalNamespaceSha256: state.journalAdapter.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    runtimeEpochSha256: tenantRestoreRuntimeEpochSha256(PRIMARY_EPOCH_ID),
    targets: [state.descriptor],
    observedHeads: [{
      ...state.descriptor,
      logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
      sealedRemoteSequence: head.remoteSequence,
      sealedHeadRootSha256: head.headRootSha256,
    }],
  });
  await state.store.activateBlobStorageControl({
    expectedControlGeneration: 0,
    storageBackend: "memory-v1",
    namespaceSha256: sha256("backup-cli-blob-namespace"),
  });
}

async function activateCatalog(state: Harness): Promise<void> {
  await initializePrimary(state);
  await runBackupCatalogCli(["activate"], activateEnv(), state.dependencies);
}

async function createAndPublish(
  state: Harness,
  backupId: string,
  label: string,
): Promise<void> {
  await runBackupCatalogCli(
    ["begin-backup"],
    catalogEnv({ BACKUP_ID: backupId, RESTORE_FLEET_STOPPED_ACK: "1" }),
    state.dependencies,
  );
  await runBackupCatalogCli(["publish-backup"], publishEnv(backupId, label), state.dependencies);
}

async function externalAvailability(
  state: Harness,
  backupId: string,
  label: string,
  anchorSha256?: string,
) {
  const control = await state.store.getTenantBackupCatalogControl();
  const anchor = await state.store.getTenantBackupSnapshotAnchor(backupId);
  const registeredAtDbMs = anchor?.createdAtDbMs ?? state.clock.value;
  return {
    backupId,
    anchorSha256: anchor?.anchorSha256 ?? anchorSha256 ?? sha256(`${label}-anchor`),
    sourceSnapshotSha256: publishValues(label).SOURCE_SNAPSHOT_SHA256,
    sourceBackupSha256: publishValues(label).SOURCE_BACKUP_SHA256,
    artifactManifestSha256: publishValues(label).BACKUP_ARTIFACT_MANIFEST_SHA256,
    providerEvidenceSha256: publishValues(label).BACKUP_PROVIDER_EVIDENCE_SHA256,
    controlEvidenceSha256: control.state === "active"
      ? control.evidenceSha256
      : sha256("inactive-external-control"),
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    retentionPolicySha256: state.catalogConfig.retentionPolicySha256!,
    retentionUntilDbMs: anchor?.retentionUntilDbMs
      ?? registeredAtDbMs + state.catalogConfig.minimumRetentionMs!,
    registeredAtDbMs,
  };
}

describe("backup catalog CLI", () => {
  it("rejects invalid authority before loading config, constructing clients, or connecting", async () => {
    const state = createHarness();
    const privateMarker = "private-invalid-authority-marker";
    let failure: unknown;
    try {
      await runBackupCatalogCli(["activate"], activateEnv({
        BACKUP_CATALOG_ACTIVATION_ACK: privateMarker,
      }), state.dependencies);
    } catch (error) {
      failure = error;
    }
    expect(state.loadCatalogConfig).not.toHaveBeenCalled();
    expect(state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(state.createJournalAdapters).not.toHaveBeenCalled();
    expect(state.connectStore).not.toHaveBeenCalled();
    expect(formatBackupCatalogCliError(failure))
      .toBe('{"status":"error","code":"invalid_configuration"}');
    expect(formatBackupCatalogCliError(failure)).not.toContain(privateMarker);
  });

  it("requires a stopped-fleet acknowledgement before either physical eviction command", async () => {
    for (const command of ["prepare-eviction", "record-eviction"] as const) {
      const state = createHarness();
      let failure: unknown;
      try {
        await runBackupCatalogCli([command], catalogEnv({
          BACKUP_ID: BACKUP_ID_1,
          BACKUP_EVICTION_ID: EVICTION_ID,
          ...(command === "record-eviction" ? {
            BACKUP_PHYSICAL_ABSENCE_ACK: "1",
            EXTERNAL_TOMBSTONE_SHA256: sha256("eviction-authority-tombstone"),
          } : {}),
        }), state.dependencies);
      } catch (error) {
        failure = error;
      }
      expect(formatBackupCatalogCliError(failure))
        .toBe('{"status":"error","code":"invalid_configuration"}');
      expect(state.loadCatalogConfig).not.toHaveBeenCalled();
      expect(state.createCatalogAdapter).not.toHaveBeenCalled();
      expect(state.connectStore).not.toHaveBeenCalled();
    }
  });

  it("requires a stopped-fleet acknowledgement before beginning a backup anchor", async () => {
    const state = createHarness();
    let failure: unknown;
    try {
      await runBackupCatalogCli(
        ["begin-backup"],
        catalogEnv({ BACKUP_ID: BACKUP_ID_1 }),
        state.dependencies,
      );
    } catch (error) {
      failure = error;
    }
    expect(formatBackupCatalogCliError(failure))
      .toBe('{"status":"error","code":"invalid_configuration"}');
    expect(state.loadCatalogConfig).not.toHaveBeenCalled();
    expect(state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(state.connectStore).not.toHaveBeenCalled();
  });

  it("keeps dormant status and list database-only", async () => {
    const state = createHarness();
    await runBackupCatalogCli(["status"], baseEnv(), state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      status: "ok",
      command: "status",
      catalogState: "inactive",
      catalogControlGeneration: 0,
      recoverableBackupCount: 0,
      externalCatalogSequence: null,
    });
    await runBackupCatalogCli(["list"], baseEnv(), state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toEqual({
      status: "ok",
      command: "list",
      count: 0,
      nextAfterBackupId: null,
      backups: [],
    });
    expect(state.loadCatalogConfig).not.toHaveBeenCalled();
    expect(state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(state.createJournalAdapters).not.toHaveBeenCalled();
    expect(state.connectStore).toHaveBeenNthCalledWith(1, {
      url: MYSQL_URL,
      connectionLimit: 1,
      migrationMode: "verify",
    });
    expect(state.connectStore).toHaveBeenNthCalledWith(2, {
      url: MYSQL_URL,
      connectionLimit: 1,
      migrationMode: "verify",
    });
  });

  it("requires an empty external head and active journal/runtime/blob prerequisites", async () => {
    const nonEmpty = createHarness();
    await initializePrimary(nonEmpty);
    await nonEmpty.catalogDelegate.publishAvailability(await externalAvailability(
      nonEmpty,
      BACKUP_ID_3,
      "external-only",
      sha256("external-only-anchor"),
    ));
    await expect(runBackupCatalogCli(
      ["activate"],
      activateEnv(),
      nonEmpty.dependencies,
    )).rejects.toMatchObject({ code: "catalog_conflict" });
    expect(await nonEmpty.store.getTenantBackupCatalogControl()).toEqual({
      singletonId: 1,
      state: "inactive",
      controlGeneration: 0,
    });

    const inactive = createHarness();
    await expect(runBackupCatalogCli(
      ["activate"],
      activateEnv(),
      inactive.dependencies,
    )).rejects.toMatchObject({ code: "catalog_not_ready" });
    expect(await inactive.store.getTenantBackupCatalogControl()).toEqual({
      singletonId: 1,
      state: "inactive",
      controlGeneration: 0,
    });
  });

  it("replays begin and publish exactly after a committed external response is lost", async () => {
    const state = createHarness({ loseFirstCatalogEventResponse: true });
    await activateCatalog(state);
    await runBackupCatalogCli(
      ["begin-backup"],
      catalogEnv({ BACKUP_ID: BACKUP_ID_1, RESTORE_FLEET_STOPPED_ACK: "1" }),
      state.dependencies,
    );
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "begin-backup",
      disposition: "created",
      backupId: BACKUP_ID_1,
    });
    await runBackupCatalogCli(
      ["begin-backup"],
      catalogEnv({ BACKUP_ID: BACKUP_ID_1, RESTORE_FLEET_STOPPED_ACK: "1" }),
      state.dependencies,
    );
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "begin-backup",
      disposition: "exact_replay",
    });

    let failure: unknown;
    try {
      await runBackupCatalogCli(
        ["publish-backup"],
        publishEnv(BACKUP_ID_1, "backup-one"),
        state.dependencies,
      );
    } catch (error) {
      failure = error;
    }
    expect(formatBackupCatalogCliError(failure))
      .toBe('{"status":"error","code":"operation_failed"}');
    expect(formatBackupCatalogCliError(failure)).not.toContain(RESPONSE_LOSS_MARKER);
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_1)).toBeNull();
    expect(await state.catalogDelegate.inspectAvailability(BACKUP_ID_1)).not.toBeNull();

    await runBackupCatalogCli(
      ["publish-backup"],
      publishEnv(BACKUP_ID_1, "backup-one"),
      state.dependencies,
    );
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "publish-backup",
      disposition: "created",
      backupId: BACKUP_ID_1,
    });
    await runBackupCatalogCli(
      ["publish-backup"],
      publishEnv(BACKUP_ID_1, "backup-one"),
      state.dependencies,
    );
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "publish-backup",
      disposition: "exact_replay",
    });

    const configLoadsBeforeList = state.loadCatalogConfig.mock.calls.length;
    await runBackupCatalogCli(["list"], baseEnv(), state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "list",
      count: 1,
      backups: [{
        backupId: BACKUP_ID_1,
        sourceBackupSha256: publishValues("backup-one").SOURCE_BACKUP_SHA256,
      }],
    });
    expect(state.loadCatalogConfig).toHaveBeenCalledTimes(configLoadsBeforeList);
  });

  it("fully reconciles the external chain before creating a snapshot anchor", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await state.catalogDelegate.publishAvailability(await externalAvailability(
      state,
      BACKUP_ID_3,
      "external-before-anchor",
      sha256("missing-external-anchor"),
    ));
    const mirror = vi.spyOn(state.store, "mirrorTenantBackupCatalogEvent");

    await runBackupCatalogCli(
      ["begin-backup"],
      catalogEnv({
        BACKUP_ID: BACKUP_ID_1,
        RESTORE_FLEET_STOPPED_ACK: "1",
      }),
      state.dependencies,
    );

    const anchor = await state.store.getTenantBackupSnapshotAnchor(BACKUP_ID_1);
    const externalHead = await state.catalogDelegate.readHead();
    expect(anchor).toMatchObject({
      sourceCatalogSequence: externalHead.catalogSequence,
      sourceCatalogEventRootSha256: externalHead.catalogEventRootSha256,
    });
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_3)).not.toBeNull();
    expect(mirror).toHaveBeenCalledOnce();
  });

  it("fails closed when the recorded availability is not the exact published result", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await runBackupCatalogCli(
      ["begin-backup"],
      catalogEnv({
        BACKUP_ID: BACKUP_ID_1,
        RESTORE_FLEET_STOPPED_ACK: "1",
      }),
      state.dependencies,
    );
    const record = state.store.recordTenantBackupCatalogAvailability.bind(state.store);
    state.store.recordTenantBackupCatalogAvailability = async (input) => {
      const result = await record(input);
      return {
        ...result,
        value: {
          ...result.value,
          controlEvidenceSha256: sha256("tampered-control-evidence"),
        },
      };
    };

    await expect(runBackupCatalogCli(
      ["publish-backup"],
      publishEnv(BACKUP_ID_1, "backup-one"),
      state.dependencies,
    )).rejects.toMatchObject({ code: "invalid_durable_state" });
  });

  it("reconciles the sealed external prefix before reserving a restore epoch", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await createAndPublish(state, BACKUP_ID_1, "backup-one");
    await state.catalogDelegate.publishAvailability(await externalAvailability(
      state,
      BACKUP_ID_3,
      "external-before-restore",
      sha256("missing-restore-anchor"),
    ));
    const reserve = state.catalogAdapter.reserveRestore.bind(state.catalogAdapter);
    state.catalogAdapter.reserveRestore = vi.fn(async (input) => {
      expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_3)).not.toBeNull();
      return reserve(input);
    });

    await runBackupCatalogCli(
      ["prepare-restore"],
      prepareRestoreEnv(),
      state.dependencies,
    );

    expect(state.catalogAdapter.reserveRestore).toHaveBeenCalledOnce();
    expect(await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID))
      .toMatchObject({ phase: "reserved" });
  });

  it("does not reserve an external epoch when restore preflight fails", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await createAndPublish(state, BACKUP_ID_1, "backup-one");
    state.store.preflightTenantRestoreReplayFromBackup = vi.fn(async () => {
      throw new Error(RESPONSE_LOSS_MARKER);
    });
    const reserve = vi.spyOn(state.catalogAdapter, "reserveRestore");

    let failure: unknown;
    try {
      await runBackupCatalogCli(
        ["prepare-restore"],
        prepareRestoreEnv(),
        state.dependencies,
      );
    } catch (error) {
      failure = error;
    }

    expect(formatBackupCatalogCliError(failure))
      .toBe('{"status":"error","code":"operation_failed"}');
    expect(formatBackupCatalogCliError(failure)).not.toContain(RESPONSE_LOSS_MARKER);
    expect(reserve).not.toHaveBeenCalled();
    expect(await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID)).toBeNull();
  });

  it("atomically projects a restore reservation and exactly replays DB response loss", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await createAndPublish(state, BACKUP_ID_1, "backup-one");

    const originalPrepare = state.store.prepareTenantRestoreReplayFromBackup.bind(state.store);
    let loseResponse = true;
    state.store.prepareTenantRestoreReplayFromBackup = async (input) => {
      const result = await originalPrepare(input);
      if (loseResponse) {
        loseResponse = false;
        throw new Error(RESPONSE_LOSS_MARKER);
      }
      return result;
    };
    vi.mocked(state.storeClose).mockClear();
    vi.mocked(state.catalogAdapter.close).mockClear();
    vi.mocked(state.journalAdapter.close).mockClear();

    let failure: unknown;
    try {
      await runBackupCatalogCli(
        ["prepare-restore"],
        prepareRestoreEnv(),
        state.dependencies,
      );
    } catch (error) {
      failure = error;
    }
    expect(formatBackupCatalogCliError(failure))
      .toBe('{"status":"error","code":"operation_failed"}');
    expect(formatBackupCatalogCliError(failure)).not.toContain(RESPONSE_LOSS_MARKER);
    expect(await state.store.getTenantBackupRestoreSourceBinding(RESTORE_RUN_ID))
      .toMatchObject({ backupId: BACKUP_ID_1, restoreRunId: RESTORE_RUN_ID });
    expect(await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID))
      .toMatchObject({ phase: "reserved", restoreRunId: RESTORE_RUN_ID });
    expect(await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))
      .toMatchObject({ phase: "prepared", restoreRunId: RESTORE_RUN_ID });
    expect(state.storeClose).toHaveBeenCalledOnce();
    expect(state.catalogAdapter.close).toHaveBeenCalledOnce();
    expect(state.journalAdapter.close).toHaveBeenCalledOnce();

    await runBackupCatalogCli(
      ["prepare-restore"],
      prepareRestoreEnv(),
      state.dependencies,
    );
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "prepare-restore",
      disposition: "exact_replay",
      backupId: BACKUP_ID_1,
      restoreRunId: RESTORE_RUN_ID,
      restorePhase: "prepared",
    });
  });

  it("resolves a terminal restore and replays the terminal projection exactly", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await createAndPublish(state, BACKUP_ID_1, "backup-one");
    await runBackupCatalogCli(
      ["prepare-restore"],
      prepareRestoreEnv(),
      state.dependencies,
    );
    expect(await state.store.abortTenantRestoreReplay(RESTORE_RUN_ID)).toBe(true);
    const env = catalogEnv({
      RESTORE_RUN_ID,
      RESTORE_FLEET_STOPPED_ACK: "1",
    });
    await runBackupCatalogCli(["resolve-restore"], env, state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "resolve-restore",
      disposition: "created",
      restoreRunId: RESTORE_RUN_ID,
      phase: "aborted",
    });
    await runBackupCatalogCli(["resolve-restore"], env, state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "resolve-restore",
      disposition: "exact_replay",
      phase: "aborted",
    });
    expect(await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID))
      .toMatchObject({ phase: "aborted" });
  });

  it("enforces retention and external-head equality before eviction, then records it", async () => {
    const state = createHarness({ minimumRetentionMs: 100, minimumRecoverableBackups: 1 });
    await activateCatalog(state);
    await createAndPublish(state, BACKUP_ID_1, "backup-one");
    await createAndPublish(state, BACKUP_ID_2, "backup-two");
    const prepareEnv = catalogEnv({
      BACKUP_ID: BACKUP_ID_1,
      BACKUP_EVICTION_ID: EVICTION_ID,
      RESTORE_FLEET_STOPPED_ACK: "1",
    });
    let retentionFailure: unknown;
    try {
      await runBackupCatalogCli(["prepare-eviction"], prepareEnv, state.dependencies);
    } catch (error) {
      retentionFailure = error;
    }
    expect(formatBackupCatalogCliError(retentionFailure))
      .toBe('{"status":"error","code":"catalog_not_ready"}');

    state.clock.value += 101;
    await runBackupCatalogCli(["prepare-eviction"], prepareEnv, state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "prepare-eviction",
      evictionId: EVICTION_ID,
      backupId: BACKUP_ID_1,
      expectedCatalogSequence: 2,
    });
    const recordEnv = {
      ...prepareEnv,
      BACKUP_PHYSICAL_ABSENCE_ACK: "1",
      EXTERNAL_TOMBSTONE_SHA256: sha256("backup-one-external-tombstone"),
    };
    const originalRecord = state.store.recordTenantBackupCatalogEviction.bind(state.store);
    let loseDatabaseProjection = true;
    state.store.recordTenantBackupCatalogEviction = async (input) => {
      if (loseDatabaseProjection) {
        loseDatabaseProjection = false;
        throw new Error(RESPONSE_LOSS_MARKER);
      }
      return originalRecord(input);
    };
    let responseLoss: unknown;
    try {
      await runBackupCatalogCli(["record-eviction"], recordEnv, state.dependencies);
    } catch (error) {
      responseLoss = error;
    }
    expect(formatBackupCatalogCliError(responseLoss))
      .toBe('{"status":"error","code":"operation_failed"}');
    expect((await state.catalogDelegate.readHead()).catalogSequence).toBe(3);
    expect(await state.store.getTenantBackupCatalogEviction(BACKUP_ID_1)).toBeNull();

    await runBackupCatalogCli(["record-eviction"], recordEnv, state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "record-eviction",
      disposition: "created",
      backupId: BACKUP_ID_1,
      catalogSequence: 3,
    });
    await runBackupCatalogCli(["record-eviction"], recordEnv, state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "record-eviction",
      disposition: "exact_replay",
      backupId: BACKUP_ID_1,
      catalogSequence: 3,
    });
    expect(await state.store.getTenantBackupCatalogEviction(BACKUP_ID_1)).not.toBeNull();

    const headMismatch = createHarness({
      minimumRetentionMs: 0,
      minimumRecoverableBackups: 1,
    });
    await activateCatalog(headMismatch);
    await createAndPublish(headMismatch, BACKUP_ID_1, "backup-one");
    await createAndPublish(headMismatch, BACKUP_ID_2, "backup-two");
    const originalPrepare = headMismatch.store.prepareTenantBackupEviction.bind(
      headMismatch.store,
    );
    headMismatch.store.prepareTenantBackupEviction = async (input) => {
      const plan = await originalPrepare(input);
      await headMismatch.catalogDelegate.publishAvailability(await externalAvailability(
        headMismatch,
        BACKUP_ID_3,
        "external-race",
        sha256("external-race-anchor"),
      ));
      return plan;
    };
    let headFailure: unknown;
    try {
      await runBackupCatalogCli(
        ["prepare-eviction"],
        prepareEnv,
        headMismatch.dependencies,
      );
    } catch (error) {
      headFailure = error;
    }
    expect(formatBackupCatalogCliError(headFailure))
      .toBe('{"status":"error","code":"catalog_conflict"}');
    expect(await headMismatch.store.getTenantBackupCatalogEviction(BACKUP_ID_1)).toBeNull();
  });

  it("reconciles externally committed availability in bounded pages when anchors survive", async () => {
    const state = createHarness();
    await activateCatalog(state);
    for (const backupId of [BACKUP_ID_1, BACKUP_ID_2]) {
      await runBackupCatalogCli(
        ["begin-backup"],
        catalogEnv({ BACKUP_ID: backupId, RESTORE_FLEET_STOPPED_ACK: "1" }),
        state.dependencies,
      );
    }
    await state.catalogDelegate.publishAvailability(await externalAvailability(
      state,
      BACKUP_ID_1,
      "backup-one",
    ));
    await state.catalogDelegate.publishAvailability(await externalAvailability(
      state,
      BACKUP_ID_2,
      "backup-two",
    ));
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_1)).toBeNull();
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_2)).toBeNull();
    const scan = vi.spyOn(state.catalogAdapter, "scanEvents");
    const mirror = vi.spyOn(state.store, "mirrorTenantBackupCatalogEvent");

    await runBackupCatalogCli(
      ["reconcile"],
      catalogEnv({ BACKUP_CATALOG_PAGE_SIZE: "1" }),
      state.dependencies,
    );

    expect(JSON.parse(state.output.at(-1)!)).toEqual({
      status: "ok",
      command: "reconcile",
      eventCount: 2,
      projectedCount: 2,
    });
    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan.mock.calls.map(([input]) => input.limit)).toEqual([1, 1]);
    expect(mirror).toHaveBeenCalledTimes(2);
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_1)).not.toBeNull();
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_2)).not.toBeNull();
  });

  it("reconciles an externally committed activated resolution onto an active replay run", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await createAndPublish(state, BACKUP_ID_1, "backup-one");
    await runBackupCatalogCli(
      ["prepare-restore"],
      prepareRestoreEnv(),
      state.dependencies,
    );
    await state.store.sealTenantRestoreReplay(RESTORE_RUN_ID);
    const runtime = await state.store.getTenantRestoreRuntimeControl();
    if (runtime.state !== "active") throw new Error("expected an active primary runtime");
    await state.store.activateTenantRestoreRuntime({
      restoreRunId: RESTORE_RUN_ID,
      expectedControlGeneration: runtime.controlGeneration,
    });
    const reservation = await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID);
    if (!reservation) throw new Error("expected a durable restore reservation");
    await state.catalogDelegate.resolveRestore({
      restoreRunId: RESTORE_RUN_ID,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "activated",
    });
    expect(await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID))
      .toMatchObject({ phase: "reserved" });
    expect(await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))
      .toMatchObject({ phase: "active" });

    await runBackupCatalogCli(["reconcile"], catalogEnv(), state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "reconcile",
      eventCount: 3,
      projectedCount: 3,
    });
    expect(await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID))
      .toMatchObject({ phase: "activated" });

    await runBackupCatalogCli(["reconcile"], catalogEnv(), state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "reconcile",
      eventCount: 3,
      projectedCount: 3,
    });
  });

  it("mirrors availability without local anchors and continues through the sealed chain", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await state.catalogDelegate.publishAvailability(await externalAvailability(
      state,
      BACKUP_ID_2,
      "external-two",
      sha256("missing-local-anchor-two"),
    ));
    await state.catalogDelegate.publishAvailability(await externalAvailability(
      state,
      BACKUP_ID_3,
      "external-three",
      sha256("missing-local-anchor-three"),
    ));
    const mirror = vi.spyOn(state.store, "mirrorTenantBackupCatalogEvent");

    await runBackupCatalogCli(["reconcile"], catalogEnv(), state.dependencies);

    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "reconcile",
      eventCount: 2,
      projectedCount: 2,
    });
    expect(mirror).toHaveBeenCalledTimes(2);
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_2)).not.toBeNull();
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_3)).not.toBeNull();
  });

  it("formats dependency failures without content and closes every acquired resource", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await createAndPublish(state, BACKUP_ID_1, "backup-one");
    state.catalogAdapter.inspectAvailability = vi.fn(async () => {
      throw new Error(RESPONSE_LOSS_MARKER);
    });
    vi.mocked(state.storeClose).mockClear();
    vi.mocked(state.catalogAdapter.close).mockClear();
    vi.mocked(state.journalAdapter.close).mockClear();

    let failure: unknown;
    try {
      await runBackupCatalogCli(
        ["prepare-restore"],
        prepareRestoreEnv(),
        state.dependencies,
      );
    } catch (error) {
      failure = error;
    }
    const formatted = formatBackupCatalogCliError(failure);
    expect(formatted).toBe('{"status":"error","code":"operation_failed"}');
    expect(formatted).not.toContain(RESPONSE_LOSS_MARKER);
    expect(state.storeClose).toHaveBeenCalledOnce();
    expect(state.catalogAdapter.close).toHaveBeenCalledOnce();
    expect(state.journalAdapter.close).toHaveBeenCalledOnce();
  });
});
