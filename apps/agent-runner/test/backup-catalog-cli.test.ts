import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MemorySessionStore,
  MysqlSessionStore,
  TenantBackupCatalogConflictError,
  type MysqlBackupCatalogPrepareMaintenance,
  MemoryTenantBackupCatalogAdapter,
  MemoryTenantRestoreJournalAdapter,
  tenantRestoreJournalTargetRootSha256,
  tenantRestoreLogicalDatabaseNamespaceSha256,
  tenantRestoreRuntimeEpochSha256,
  prepareSessionAuthorityBindingCommand, captureSessionAuthorityBindingCommand,
  prepareSessionAuthorityActivationRequest, captureSessionAuthorityActivationRequest,
  type SessionAuthorityBindingOperatorContext, type MysqlRestoreJournalMaintenanceProfile,
  createTenantTelemetryCaptureBackupCheckpoint,
  createTenantTelemetryCaptureBackupCheckpointV2, createTenantTelemetryCaptureLineageCapsule,
  tenantTelemetryCaptureLineageOpaqueDigest,
  createTenantTelemetryCaptureRestoreHistoryReceipt,
  createTenantTelemetryCaptureEpochCutoverReceipt,
  tenantTelemetryCaptureRestoreRuntimeBindingSha256,
  tenantTelemetryRefKeyIdSha256,
  newErasureRequestId,
  tenantErasureRequestHash,
  tenantBackupEvictionOperationSha256, tenantBackupEvictionPlanSha256,
  type TenantBackupCatalogAdapter,
  type TenantRestoreJournalAdapter,
  type TenantRestoreJournalTargetDescriptor,
  type TenantTelemetryCaptureRestoreMaintenance,
  type TenantTelemetryCaptureRestoreHistoryReceipt,
  type TenantTelemetryCaptureEpochCutoverReceipt,
  type TenantTelemetryCaptureBackupSourceMaintenance,
  type TenantTelemetryCaptureBackupCheckpointHeader, type TenantTelemetryCaptureLineageLeaf,
  type TenantTelemetryCaptureLineageAncestor,
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
import { MySqlBackupArtifactError } from "../src/mysql-backup-artifact.js";
import { canonicalJson } from "../src/mysql-backup-artifact-codec.js";

// These explicit values are orchestration inputs, not a native metadata/grant witness.
const SCHEMA_METADATA = Object.freeze({ metadataSchema: "backup_cli_metadata",
  trustedDefiner: Object.freeze({ user: "backup_cli_metadata_definer", host: "localhost" }) });
const STOPPED_PROFILE = Object.freeze({ kind: "stopped-fleet-maintenance" as const,
  fleetStoppedAck: "fleet-stopped-v1" as const, localOnlyAck: "local-only-v1" as const });
const SYNTHETIC_SERVER_UUID = "33333333-3333-4333-8333-333333333333";
function syntheticPhysicalIdentity(url: string): string {
  return sha256(canonicalJson({ scope: "mysql-physical-database-identity-v1",
    serverUuid: SYNTHETIC_SERVER_UUID, database: decodeURIComponent(new URL(url).pathname.slice(1)) }));
}


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
  return { MYSQL_URL,
    MYSQL_SCHEMA_METADATA_SCHEMA: SCHEMA_METADATA.metadataSchema,
    MYSQL_SCHEMA_METADATA_DEFINER_USER: SCHEMA_METADATA.trustedDefiner.user,
    MYSQL_SCHEMA_METADATA_DEFINER_HOST: SCHEMA_METADATA.trustedDefiner.host, ...extra };
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

function artifactEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return catalogEnv({
    BACKUP_ID: BACKUP_ID_1,
    BACKUP_ARTIFACT_LOCAL_ONLY_ACK: "1",
    BACKUP_ARTIFACT_DIRECTORY: "/private/fixture-artifacts",
    BACKUP_ARTIFACT_KEY_FILE: "/private/fixture-key",
    BACKUP_MYSQL_BINARY: "/private/trusted/mysql",
    BACKUP_MYSQLDUMP_BINARY: "/private/trusted/mysqldump",
    RESTORE_FLEET_STOPPED_ACK: "1",
    ...extra,
  });
}

/** Closed orchestration double, NOT a branded/connected MySQL facade. No
 * SessionStore/writer method is exposed or cast into this restricted surface. */
function sourceFacadeDouble(source: Awaited<ReturnType<BackupCatalogCliDependencies["connectStore"]>>,
  beforeUse: () => void = () => {}): TenantTelemetryCaptureBackupSourceMaintenance {
  const checked = <Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => { beforeUse(); return operation(...args); };
  return Object.freeze({
    sealTenantTelemetryCaptureBackupCheckpoint: checked(source.sealTenantTelemetryCaptureBackupCheckpoint.bind(source)),
    getTenantTelemetryCaptureBackupCheckpoint: checked(source.getTenantTelemetryCaptureBackupCheckpoint.bind(source)),
    assertTenantTelemetryCaptureBackupCheckpointUnchanged: checked(source.assertTenantTelemetryCaptureBackupCheckpointUnchanged.bind(source)),
    getTenantBackupCatalogControl: checked(source.getTenantBackupCatalogControl.bind(source)),
    createTenantBackupSnapshotAnchor: checked(source.createTenantBackupSnapshotAnchor.bind(source)),
    getTenantBackupSnapshotAnchor: checked(source.getTenantBackupSnapshotAnchor.bind(source)),
    recordTenantBackupCatalogAvailability: checked(source.recordTenantBackupCatalogAvailability.bind(source)),
    mirrorTenantBackupCatalogEvent: checked(source.mirrorTenantBackupCatalogEvent.bind(source)),
    getTenantBackupCatalogEntry: checked(source.getTenantBackupCatalogEntry.bind(source)),
    listRecoverableTenantBackups: checked(source.listRecoverableTenantBackups.bind(source)),
    preflightTenantRestoreReplayFromBackup: checked(source.preflightTenantRestoreReplayFromBackup.bind(source)),
    prepareTenantRestoreReplayFromBackup: checked(source.prepareTenantRestoreReplayFromBackup.bind(source)),
    getTenantRestoreJournalControl: checked(source.getTenantRestoreJournalControl.bind(source)),
    getTenantRestoreJournalControlTargets: checked(source.getTenantRestoreJournalControlTargets.bind(source)),
    getTenantRestoreRuntimeControl: checked(source.getTenantRestoreRuntimeControl.bind(source)),
    getTenantRestoreRuntimeHeads: checked(source.getTenantRestoreRuntimeHeads.bind(source)),
    getBlobStorageControl: checked(source.getBlobStorageControl.bind(source)), close: source.close.bind(source),
  });
}

/** Orchestration-only fake; real bytes/MySQL behavior is covered by the separate MySQL/S3 suite. */
function artifactHarness(state: Harness) {
  type Api = NonNullable<BackupCatalogCliDependencies["artifactOperations"]>;
  type Created = Awaited<ReturnType<Api["createMySqlBackupArtifact"]>>;
  const evidence: Created["evidence"] = {
    sourceSnapshotSha256: publishValues("actual-fixture").SOURCE_SNAPSHOT_SHA256,
    sourceBackupSha256: publishValues("actual-fixture").SOURCE_BACKUP_SHA256,
    artifactManifestSha256: publishValues("actual-fixture").BACKUP_ARTIFACT_MANIFEST_SHA256,
    providerEvidenceSha256: publishValues("actual-fixture").BACKUP_PROVIDER_EVIDENCE_SHA256,
  };
  const calls: string[] = [];
  let selection: Parameters<Api["acquireMySqlBackupArtifactOperator"]>[0] | undefined;
  const assertHeld = vi.fn(async () => {});
  const operator = Object.freeze({
    get sourceIdentitySha256() {
      if (!selection) throw new Error("synthetic_operator_not_acquired");
      return syntheticPhysicalIdentity(selection.sourceUrl);
    },
    get targetIdentitySha256() {
      return selection?.targetUrl === undefined ? undefined : syntheticPhysicalIdentity(selection.targetUrl);
    },
    assertHeld,
    // Only verifies this fixture's exact facade and selected role/URL while held.
    // Native CURRENT_USER/database/binding proof belongs to the MySQL/S3 suite.
    assertStoreBinding: vi.fn(async (facade: unknown, role: "source" | "target") => {
      await assertHeld();
      if (facade === null || typeof facade !== "object" || !selection) throw new Error("synthetic_facade_missing");
      const expected = role === "source" ? selection.sourceUrl : selection.targetUrl;
      if (expected === undefined || state.facadeUrls.get(facade) !== expected) throw new Error("synthetic_facade_binding_mismatch");
    }),
    close: vi.fn(async () => { calls.push("operator.close"); }),
    bindRestoreOperation: vi.fn(async () => { calls.push("operator.bind"); }),
    markRestorePrepared: vi.fn(async () => { calls.push("operator.prepared"); }),
  });
  const verifiedClose = vi.fn(async () => { calls.push("verified.close"); });
  const manifest = (anchor: Created["manifest"]["anchor"]) => ({
    version: 1, scope: "mysql-logical-full-artifact-v1",
    backupId: anchor.backupId, anchor, schemaMigrationRootSha256: anchor.schemaMigrationRootSha256,
  } as Created["manifest"]);
  const acquire = vi.fn(async (input: Parameters<Api["acquireMySqlBackupArtifactOperator"]>[0]) => {
    selection = input; calls.push("operator.acquire"); return operator;
  });
  const create = vi.fn(async (input: Parameters<Api["createMySqlBackupArtifact"]>[0]): Promise<Created> => {
    calls.push("artifact.create");
    return { disposition: "created", manifest: manifest(input.anchor), evidence };
  });
  const verify = vi.fn(async (input: Parameters<Api["verifyMySqlBackupArtifact"]>[0]) => {
    calls.push("artifact.verify");
    const anchor = input.expectedAnchor!;
    return { manifest: manifest(anchor), evidence, close: verifiedClose };
  });
  const imported = vi.fn(async () => { calls.push("artifact.import"); });
  const operations = {
    acquireMySqlBackupArtifactOperator: acquire,
    createMySqlBackupArtifact: create,
    verifyMySqlBackupArtifact: verify,
    importVerifiedMySqlBackupArtifact: imported,
  } as unknown as Api;
  state.dependencies.artifactOperations = operations;
  return { evidence, calls, operator, verifiedClose, acquire, create, verify, imported };
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
  const connectStore = vi.fn(async (_options: Parameters<BackupCatalogCliDependencies["connectStore"]>[0]) => store);
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
  const facadeUrls = new WeakMap<object, string>();
  const rememberFacade = <T extends object>(facade: T, url: string): T => { facadeUrls.set(facade, url); return facade; };
  const connectCaptureBackupSourceMaintenance = vi.fn(async (
    input: Parameters<NonNullable<BackupCatalogCliDependencies["connectCaptureBackupSourceMaintenance"]>>[0],
    profile: Parameters<NonNullable<BackupCatalogCliDependencies["connectCaptureBackupSourceMaintenance"]>>[1],
  ) => {
    expect(profile).toEqual(STOPPED_PROFILE);
    expect(input.fleetStoppedAck).toBe(STOPPED_PROFILE.fleetStoppedAck);
    expect(input.localOnlyAck).toBe(STOPPED_PROFILE.localOnlyAck);
    // A fake inner Memory dependency keeps existing error/late-close seams. It
    // does not open an ordinary MySQL pool or prove the stopped-fleet profile.
    const inner = await connectStore({ url: input.url, connectionLimit: input.connectionLimit ?? 2, migrationMode: "verify",
      schemaMetadata: SCHEMA_METADATA, tenantTelemetryCaptureRestoreLocalOnly: true,
      ...(input.tenantTelemetryRefKey === undefined ? {} : { tenantTelemetryRefKey: input.tenantTelemetryRefKey }),
      ...(input.operationAbortSignal === undefined ? {} : { operationAbortSignal: input.operationAbortSignal }) });
    return rememberFacade(sourceFacadeDouble(inner), input.url);
  });
  dependencies.connectCaptureBackupSourceMaintenance = connectCaptureBackupSourceMaintenance;
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
    connectCaptureBackupSourceMaintenance, facadeUrls, rememberFacade,
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

/** Orchestration only: inactive Memory delegates and partial artifact metadata
 * do NOT prove 0056 source audit, a real GCM FD, MySQL pool or maintenance grant. */
async function v2MaintenanceHarness(version: 1 | 2 | 3 = 2) {
  const state = createHarness(); await activateCatalog(state); const artifacts = artifactHarness(state);
  await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
  artifacts.operator.close.mockClear(); artifacts.verifiedClose.mockClear(); state.storeClose.mockClear();
  // Distinct close identities are necessary: a shared Memory store's generic
  // close spy alone could not prove that the TARGET was closed before reopen.
  const targetClose = vi.fn(async () => {});
  const targetStore = new Proxy(state.store, { get(target, property) {
    if (property === "close") return targetClose;
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  state.connectStore.mockImplementation(async (options) => options.url === "mysql://fixture@127.0.0.1:3306/isolated_target" ? targetStore : state.store);
  const checkpointSha256 = sha256("selected-v2-checkpoint");
  artifacts.verify.mockImplementationOnce(async (input) => ({
    manifest: { version, scope: `mysql-logical-full-artifact-v${version}`, backupId: input.expectedAnchor!.backupId,
      anchor: input.expectedAnchor!, schemaMigrationRootSha256: input.expectedAnchor!.schemaMigrationRootSha256,
      ...(version === 1 ? {} : { captureCheckpoint: { checkpointSha256 } }) } as never,
    evidence: artifacts.evidence, close: artifacts.verifiedClose,
  }));
  const preflightDelegate = state.store.preflightTenantRestoreReplayFromBackup.bind(state.store);
  const prepareDelegate = state.store.prepareTenantRestoreReplayFromBackup.bind(state.store);
  const preflight = vi.spyOn(state.store, "preflightTenantRestoreReplayFromBackup").mockImplementation(async (input) => {
    expect(input.captureCheckpointSha256).toBe(version === 1 ? undefined : checkpointSha256);
    const { captureCheckpointSha256: _hash, ...legacy } = input; return preflightDelegate(legacy);
  });
  const prepare = vi.spyOn(state.store, "prepareTenantRestoreReplayFromBackup").mockImplementation(async (input) => {
    expect(input.captureCheckpointSha256).toBe(version === 1 ? undefined : checkpointSha256);
    const { captureCheckpointSha256: _hash, ...legacy } = input; return prepareDelegate(legacy);
  });
  const reserve = vi.spyOn(state.catalogAdapter, "reserveRestore");
  const observed: string[] = [];
  const assertHeldResources = (stage: string) => {
    expect(targetClose).toHaveBeenCalledOnce();
    expect(state.storeClose).not.toHaveBeenCalled();
    expect(artifacts.verifiedClose).not.toHaveBeenCalled();
    expect(artifacts.operator.close).not.toHaveBeenCalled();
    observed.push(stage);
  };
  const unused = async (): Promise<never> => { throw new Error("unexpected maintenance mutation"); };
  const maintenance = Object.freeze({
    getTenantRestoreReplayRun: vi.fn((runId: string) => { assertHeldResources("run"); return state.store.getTenantRestoreReplayRun(runId); }),
    getTenantTelemetryCaptureRestoreHistoryReceipt: vi.fn(async (): ReturnType<TenantTelemetryCaptureRestoreMaintenance["getTenantTelemetryCaptureRestoreHistoryReceipt"]> => {
      assertHeldResources("history"); return null;
    }),
    getTenantRestoreReplaySealedTargets: unused, listTenantRestoreReplayEntries: unused,
    recordTenantRestoreReplayFence: unused, sealTenantRestoreReplay: unused,
    abortTenantRestoreReplay: unused, getTenantRestoreReplayReceipt: unused,
    getTenantRestoreRuntimeControl: unused, getTenantRestoreRuntimeHeads: unused,
    activateTenantRestoreRuntime: unused, getTenantRestoreJournalControl: unused,
    getTenantRestoreJournalControlTargets: unused, getTenantBackupRestoreSourceBinding: unused,
    getTenantBackupRuntimeReservation: unused, activateTenantTelemetryCaptureRestoredEpoch: unused,
    resolveTenantBackupRuntimeReservation: unused,
    confirmSessionAuthorityBinding: unused,
    getTenantTelemetryCaptureEpochCutoverReceipt: unused, close: vi.fn(async () => {}),
  } satisfies TenantTelemetryCaptureRestoreMaintenance);
  state.rememberFacade(maintenance, "mysql://fixture@127.0.0.1:3306/isolated_target");
  const connectMaintenance = vi.fn(async (
    options: Parameters<NonNullable<BackupCatalogCliDependencies["connectCaptureRestoreMaintenance"]>>[0],
    profile: Parameters<NonNullable<BackupCatalogCliDependencies["connectCaptureRestoreMaintenance"]>>[1],
  ): Promise<TenantTelemetryCaptureRestoreMaintenance> => {
    expect(profile).toEqual(STOPPED_PROFILE);
    expect(state.facadeUrls.get(maintenance)).toBe(options.url);
    assertHeldResources("factory"); return maintenance;
  });
  state.dependencies.connectCaptureRestoreMaintenance = connectMaintenance;
  const refKey = Buffer.alloc(32, 17);
  state.dependencies.readRefKey = async () => refKey;
  const restoreEnv = (extra: NodeJS.ProcessEnv = {}) => artifactEnv({ RESTORE_RUN_ID,
    BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID, BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/isolated_target",
    TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/fixture-ref-key", ...extra });
  return { state, artifacts, checkpointSha256, preflight, prepare, reserve, maintenance, connectMaintenance,
    assertHeldResources, observed, refKey, restoreEnv, targetClose };
}

/** Cause-specific orchestration fixture. After the real Memory prepare returns,
 * EVERY source facade operation (except cleanup close) throws. The target uses
 * its separate facade. This is not a SQL pending-gate or GCM/source-audit proof. */
async function postPrepareFencedSourceHarness(version: 1 | 2 | 3,
  afterPrepare?: (prepared: Awaited<ReturnType<TenantTelemetryCaptureBackupSourceMaintenance["prepareTenantRestoreReplayFromBackup"]>>,
    state: Harness) => Promise<Awaited<ReturnType<TenantTelemetryCaptureBackupSourceMaintenance["prepareTenantRestoreReplayFromBackup"]>>>) {
  const h = await v2MaintenanceHarness(version);
  let fenced = false;
  const useAfterFence = vi.fn(() => {});
  const base = sourceFacadeDouble(h.state.store, () => {
    if (fenced) { useAfterFence(); throw new Error("fixture_pending_source_forbids_every_operation"); }
  });
  const source = Object.freeze({ ...base,
    async prepareTenantRestoreReplayFromBackup(input: Parameters<typeof base.prepareTenantRestoreReplayFromBackup>[0]) {
      const prepared = await base.prepareTenantRestoreReplayFromBackup(input);
      fenced = true;
      return afterPrepare ? afterPrepare(prepared, h.state) : prepared;
    },
  } satisfies TenantTelemetryCaptureBackupSourceMaintenance);
  const connect = h.state.connectCaptureBackupSourceMaintenance.getMockImplementation();
  if (!connect) throw new Error("source_facade_fixture_factory_missing");
  h.state.rememberFacade(source, MYSQL_URL);
  h.state.connectCaptureBackupSourceMaintenance.mockImplementation((input, profile) => {
    expect(profile).toEqual(STOPPED_PROFILE);
    return input.url === MYSQL_URL ? Promise.resolve(source) : connect(input, profile);
  });
  return { ...h, source, useAfterFence, isFenced: () => fenced };
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

const SELECTED_TARGET_URL = "mysql://fixture@127.0.0.1:3306/existing_selected_target";
/** Explicit orchestration double: real Memory 0030/0031 transitions and official
 * codec outputs below do NOT prove GCM bytes, active-capture source audit, MySQL
 * bootstrap/locks, a configured stopped fleet, external durability or cutover.
 * The GCM reader/bootstrap/capture facade are deliberately injected stubs. */
async function selectedContinuationHarness(version: 2 | 3 = 2) {
  const state = createHarness(); await activateCatalog(state);
  const requestId = newErasureRequestId(), tenantId = "selection-fence-tenant";
  await state.store.createApiKey(tenantId, "selection-key", "selection-not-a-secret");
  await state.store.requestTenantErasure({ requestId, tenantId, requestedByKeyId: "fixture-admin",
    idempotencyKey: "selection-fence", requestHash: tenantErasureRequestHash(tenantId), atMs: state.clock.value });
  const claim = (await state.store.claimTenantRestoreJournalPublications({ limit: 1, leaseMs: 60_000, claimToken: "selection-publication" }))[0];
  if (!claim) throw new Error("selection publication fixture missing");
  const authorization = { requestId: claim.requestId, tenantId: claim.tenantId, subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt, claimToken: claim.claimToken, publicationGeneration: claim.publicationGeneration };
  const pending = await state.store.getTenantRestoreJournalPublicationRecord(authorization, 0);
  if (!pending) throw new Error("selection record fixture missing");
  const remote = await state.journalDelegate.publishRecord(pending.record);
  await state.store.recordTenantRestoreJournalPublicationTargetAck(authorization, remote);
  await state.store.sealTenantRestoreJournalPublication(authorization);
  const artifacts = artifactHarness(state);
  await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
  const anchor = await state.store.getTenantBackupSnapshotAnchor(BACKUP_ID_1);
  const runtime = await state.store.getTenantRestoreRuntimeControl(), journal = await state.store.getTenantRestoreJournalControl();
  const entry = await state.store.getTenantBackupCatalogEntry(BACKUP_ID_1);
  const blob = await state.store.getBlobStorageControl();
  if (!anchor || !entry || runtime.state !== "active" || journal.controlGeneration !== 1 || blob.controlGeneration !== 1) {
    throw new Error("selection fixture control missing");
  }
  const key = Buffer.alloc(32, 0x43), originalBinding = sha256("selection-fixture-original-binding");
  const checkpointHeader: TenantTelemetryCaptureBackupCheckpointHeader = { backupId: BACKUP_ID_1, anchorSha256: anchor.anchorSha256,
    anchorCreatedAtDbMs: anchor.createdAtDbMs, controlHighWaterDbMs: state.clock.value,
    logicalDatabaseNamespaceSha256: anchor.logicalDatabaseNamespaceSha256, schemaMigrationRootSha256: anchor.schemaMigrationRootSha256,
    sourceRuntimeLineageKind: "primary", sourceRuntimeEpochSha256: runtime.runtimeEpochSha256,
    sourceRuntimeBindingSha256: originalBinding, sourceRuntimeControlEvidenceSha256: runtime.evidenceSha256,
    sourceRuntimeControlGeneration: runtime.controlGeneration, sourceHistoryReceiptSha256: null, sourceCaptureCutoverReceiptSha256: null,
    originalRuntimeEpochSha256: runtime.runtimeEpochSha256, originalRuntimeBindingSha256: originalBinding,
    originalCaptureActivationReceiptSha256: sha256("selection-fixture-capture-activation"), refKeyIdSha256: tenantTelemetryRefKeyIdSha256(key),
    lifecycleControlEvidenceSha256: sha256("selection-fixture-lifecycle"), captureControlEvidenceSha256: sha256("selection-fixture-capture"),
    logsTargetSha256: sha256("selection-fixture-logs"), logsTargetReceiptSha256: sha256("selection-fixture-logs-receipt"),
    journalControlEvidenceSha256: journal.evidenceSha256, journalTargetRootSha256: journal.targetRootSha256,
    journalHeadRootSha256: runtime.verifiedHeadRootSha256, catalogControlEvidenceSha256: anchor.controlEvidenceSha256,
    catalogHeadSequence: anchor.sourceCatalogSequence, catalogHeadRootSha256: anchor.sourceCatalogEventRootSha256,
    blobStorageControlEvidenceSha256: blob.evidenceSha256, sealedAtDbMs: state.clock.value };
  const checkpoint = createTenantTelemetryCaptureBackupCheckpoint(checkpointHeader, [], key);
  if (version === 3) {
    // Synthetic ancestry is deliberately codec-only. The actual store factory
    // must reject caller-created ancestry; this harness stubs that boundary.
    checkpointHeader.sourceRuntimeLineageKind = "restore";
    checkpointHeader.sourceHistoryReceiptSha256 = sha256("synthetic-source-history");
    checkpointHeader.sourceCaptureCutoverReceiptSha256 = sha256("synthetic-source-cutover");
    checkpointHeader.originalRuntimeEpochSha256 = sha256("synthetic-genesis-epoch");
    checkpointHeader.originalRuntimeBindingSha256 = sha256("synthetic-genesis-binding");
    const families = ["checkpoint", "restore_history", "epoch_cutover", "restore_binding", "runtime_event"] as const;
    const lineageLeaves: TenantTelemetryCaptureLineageLeaf[] = families.map((family) => ({ family,
      identityRefSha256: tenantTelemetryCaptureLineageOpaqueDigest(family, "identity", Buffer.from(`synthetic-${family}`), key),
      recordHmacSha256: tenantTelemetryCaptureLineageOpaqueDigest(family, "record", Buffer.from(`synthetic-record-${family}`), key),
      sourceHighWaterDbMs: state.clock.value }));
    const leaf = (family: typeof families[number]) => lineageLeaves.find((row) => row.family === family)!;
    const ancestor: TenantTelemetryCaptureLineageAncestor = { restoreRunId: "restore_00000000-0000-4000-8000-000000000000",
      checkpointSha256: sha256("synthetic-source-checkpoint"), historyReceiptSha256: checkpointHeader.sourceHistoryReceiptSha256,
      cutoverReceiptSha256: checkpointHeader.sourceCaptureCutoverReceiptSha256, runtimeEpochSha256: checkpointHeader.sourceRuntimeEpochSha256,
      runtimeBindingSha256: checkpointHeader.sourceRuntimeBindingSha256, runtimeControlGeneration: checkpointHeader.sourceRuntimeControlGeneration,
      checkpointIdentityRefSha256: leaf("checkpoint").identityRefSha256, checkpointRecordHmacSha256: leaf("checkpoint").recordHmacSha256,
      historyIdentityRefSha256: leaf("restore_history").identityRefSha256, historyRecordHmacSha256: leaf("restore_history").recordHmacSha256,
      cutoverIdentityRefSha256: leaf("epoch_cutover").identityRefSha256, cutoverRecordHmacSha256: leaf("epoch_cutover").recordHmacSha256,
      restoreBindingIdentityRefSha256: leaf("restore_binding").identityRefSha256, restoreBindingRecordHmacSha256: leaf("restore_binding").recordHmacSha256,
      runtimeEventIdentityRefSha256: leaf("runtime_event").identityRefSha256, runtimeEventRecordHmacSha256: leaf("runtime_event").recordHmacSha256 };
    const lineage = createTenantTelemetryCaptureLineageCapsule({ backupId: BACKUP_ID_1, anchorSha256: anchor.anchorSha256,
      refKeyIdSha256: checkpointHeader.refKeyIdSha256, sourceRestoreRunId: ancestor.restoreRunId, sourceCheckpointSha256: ancestor.checkpointSha256,
      sourceHistoryReceiptSha256: ancestor.historyReceiptSha256, sourceCaptureCutoverReceiptSha256: checkpointHeader.sourceCaptureCutoverReceiptSha256,
      sourceRuntimeEpochSha256: checkpointHeader.sourceRuntimeEpochSha256, sourceRuntimeBindingSha256: checkpointHeader.sourceRuntimeBindingSha256,
      sourceRuntimeControlEvidenceSha256: checkpointHeader.sourceRuntimeControlEvidenceSha256,
      sourceRuntimeControlGeneration: checkpointHeader.sourceRuntimeControlGeneration, sealedAtDbMs: state.clock.value }, lineageLeaves, [ancestor], key);
    // Explicit union instead of asserting a CP2 record into the legacy CP1 type.
    return finishSelectedContinuationHarness(state, artifacts, anchor, entry, journal, key,
      createTenantTelemetryCaptureBackupCheckpointV2(checkpointHeader, [], lineage, lineageLeaves, key), version);
  }
  return finishSelectedContinuationHarness(state, artifacts, anchor, entry, journal, key, checkpoint, version);
}

async function finishSelectedContinuationHarness(state: Harness, artifacts: ReturnType<typeof artifactHarness>,
  anchor: NonNullable<Awaited<ReturnType<Harness["store"]["getTenantBackupSnapshotAnchor"]>>>,
  entry: NonNullable<Awaited<ReturnType<Harness["store"]["getTenantBackupCatalogEntry"]>>>,
  journal: Extract<Awaited<ReturnType<Harness["store"]["getTenantRestoreJournalControl"]>>, { controlGeneration: 1 }>,
  key: Buffer,
  checkpoint: import("@agent-service/store").TenantTelemetryCaptureBackupCheckpoint, version: 2 | 3) {
  const externalReservation = await state.catalogDelegate.reserveRestore({ backupId: BACKUP_ID_1,
    restoreRunId: RESTORE_RUN_ID, entrySha256: entry.entrySha256, runtimeEpochSha256: tenantRestoreRuntimeEpochSha256(RESTORE_EPOCH_ID) });
  const prepared = await state.store.prepareTenantRestoreReplayFromBackup({ backupId: BACKUP_ID_1, restoreRunId: RESTORE_RUN_ID,
    runtimeEpochSha256: externalReservation.runtimeEpochSha256, controlEvidenceSha256: journal.evidenceSha256,
    sealedTargets: await state.store.getTenantRestoreRuntimeHeads(), reservation: externalReservation });
  type Api = NonNullable<BackupCatalogCliDependencies["artifactOperations"]>;
  const manifest = { version, scope: `mysql-logical-full-artifact-v${version}`, backupId: BACKUP_ID_1,
    anchor, schemaMigrationRootSha256: anchor.schemaMigrationRootSha256, captureCheckpoint: checkpoint
  } as Awaited<ReturnType<Api["verifyMySqlBackupArtifact"]>>["manifest"];
  artifacts.verify.mockImplementation(async () => ({ manifest, evidence: artifacts.evidence, close: artifacts.verifiedClose }));
  let history: TenantTelemetryCaptureRestoreHistoryReceipt | null = null;
  let cutover: TenantTelemetryCaptureEpochCutoverReceipt | null = null;
  const assertHeld = () => { expect(artifacts.operator.close).not.toHaveBeenCalled(); expect(artifacts.verifiedClose).not.toHaveBeenCalled(); };
  let authorityContext: SessionAuthorityBindingOperatorContext | undefined;
  let maintenanceProfile: MysqlRestoreJournalMaintenanceProfile | undefined;
  let observedActivationRequestSha256: string | undefined;
  const nativeAdmission = vi.fn(async () => { throw new Error("synthetic_fixture_has_no_native_admission"); });
  const loadAuthorityContext: NonNullable<BackupCatalogCliDependencies["loadAuthorityContext"]> = vi.fn(async (
    configuration: Parameters<NonNullable<BackupCatalogCliDependencies["loadAuthorityContext"]>>[0],
    signal: Parameters<NonNullable<BackupCatalogCliDependencies["loadAuthorityContext"]>>[1],
  ) => {
    expect(configuration).toEqual({ url: SELECTED_TARGET_URL, commandFile: "/private/selection-authority-command.json",
      timeoutMs: 120_000, schemaMetadata: SCHEMA_METADATA });
    expect(signal).toBeInstanceOf(AbortSignal); expect(signal!.aborted).toBe(false);
    if (!authorityContext) {
      const original = await state.store.getTenantRestoreRuntimeControl();
      const sealed = await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID);
      if (original.state !== "active" || original.lineageKind !== "primary" || sealed?.phase !== "replay_sealed"
        || sealed.terminalReceiptSha256 === null) throw new Error("synthetic_authority_source_not_sealed");
      const request = captureSessionAuthorityActivationRequest(prepareSessionAuthorityActivationRequest("restore_activation", {
        restoreRunId: RESTORE_RUN_ID, expectedControlGeneration: original.controlGeneration,
      }));
      // Real opaque command parsing, synthetic identity/accounts. This DOES NOT
      // exercise native admission or install a durable MySQL binding.
      const command = prepareSessionAuthorityBindingCommand({
        bindingId: "11111111-1111-4111-8111-111111111111", activationId: "22222222-2222-4222-8222-222222222222",
        expectedBindingId: "44444444-4444-4444-8444-444444444444", expectedSequence: 1,
        serverUuid: SYNTHETIC_SERVER_UUID, applicationDatabase: decodeURIComponent(new URL(SELECTED_TARGET_URL).pathname.slice(1)),
        newAccounts: [{ user: "selection_runtime_new", host: "localhost" }], oldAccountNames: ["selection_runtime_old"],
        activationEvidenceSha256: sha256("synthetic-selection-authority-evidence"),
        expectedSource: { kind: "primary_activation", runtimeControlGeneration: original.controlGeneration,
          runtimeControlEvidenceSha256: original.evidenceSha256, runtimeEpochSha256: original.runtimeEpochSha256,
          restoreRunId: null, replayReceiptSha256: null },
        nextEpoch: { kind: "restore_activation", runtimeEpochSha256: sealed.runtimeEpochSha256, restoreRunId: RESTORE_RUN_ID,
          activationRequestSha256: request.activationRequestSha256, sealedReplayReceiptSha256: sealed.terminalReceiptSha256 },
      });
      authorityContext = Object.freeze({ command, schemaMetadata: SCHEMA_METADATA, assertNativeAdmission: nativeAdmission });
    }
    return authorityContext;
  });
  state.dependencies.loadAuthorityContext = loadAuthorityContext;
  const doActivate: TenantTelemetryCaptureRestoreMaintenance["activateTenantRestoreRuntime"] = async (input) => {
    assertHeld();
    if (!authorityContext || maintenanceProfile?.kind !== "operator-maintenance"
      || maintenanceProfile.binding !== authorityContext) throw new Error("synthetic_authority_profile_missing");
    const fixed = captureSessionAuthorityBindingCommand(authorityContext.command);
    const request = captureSessionAuthorityActivationRequest(prepareSessionAuthorityActivationRequest("restore_activation", input));
    if (fixed.nextEpoch?.kind !== "restore_activation" || fixed.nextEpoch.restoreRunId !== input.restoreRunId
      || fixed.nextEpoch.activationRequestSha256 !== request.activationRequestSha256) throw new Error("synthetic_authority_request_mismatch");
    observedActivationRequestSha256 = request.activationRequestSha256;
    const activated = await state.store.activateTenantRestoreRuntime(input);
    const run = await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID);
    if (activated.state !== "active" || !run || run.phase !== "active") throw new Error("selection activation fixture missing");
    history = createTenantTelemetryCaptureRestoreHistoryReceipt({ backupId: BACKUP_ID_1, anchorSha256: anchor.anchorSha256,
      checkpointSha256: checkpoint.checkpointSha256, artifactManifestSha256: artifacts.evidence.artifactManifestSha256,
      sourceSnapshotSha256: artifacts.evidence.sourceSnapshotSha256, providerEvidenceSha256: artifacts.evidence.providerEvidenceSha256,
      sourceBindingSha256: prepared.value.binding.bindingSha256, reservationSha256: prepared.value.reservation.reservationSha256,
      reservationReceiptSha256: prepared.value.reservation.reservationReceiptSha256, restoreRunId: RESTORE_RUN_ID,
      runtimeEpochSha256: run.runtimeEpochSha256, runtimeBindingSha256: tenantTelemetryCaptureRestoreRuntimeBindingSha256(activated, journal),
      runtimeControlEvidenceSha256: activated.evidenceSha256, runtimeControlGeneration: activated.controlGeneration,
      replayReceiptSha256: run.terminalReceiptSha256, sealedJournalHeadRootSha256: run.sealedTargetRootSha256,
      activatedAtDbMs: run.activatedAtDbMs }, checkpoint, key);
    return activated;
  };
  const doCutover: TenantTelemetryCaptureRestoreMaintenance["activateTenantTelemetryCaptureRestoredEpoch"] = async (input) => {
    assertHeld(); if (!history) throw new Error("selection history fixture missing");
    cutover ??= createTenantTelemetryCaptureEpochCutoverReceipt({
      originalRuntimeEpochSha256: checkpoint.originalRuntimeEpochSha256, originalRuntimeBindingSha256: checkpoint.originalRuntimeBindingSha256,
      originalCaptureActivationReceiptSha256: checkpoint.originalCaptureActivationReceiptSha256, refKeyIdSha256: checkpoint.refKeyIdSha256,
      lifecycleControlEvidenceSha256: checkpoint.lifecycleControlEvidenceSha256, captureControlEvidenceSha256: checkpoint.captureControlEvidenceSha256,
      logsTargetSha256: checkpoint.logsTargetSha256, logsTargetReceiptSha256: checkpoint.logsTargetReceiptSha256,
      historyReceiptSha256: history.receiptSha256, restoreRunId: RESTORE_RUN_ID, runtimeEpochSha256: input.expectedRuntimeEpochSha256,
      runtimeBindingSha256: history.runtimeBindingSha256, runtimeControlEvidenceSha256: history.runtimeControlEvidenceSha256,
      runtimeControlGeneration: history.runtimeControlGeneration, configuredFleetRootSha256: input.configuredFleetRootSha256,
      activatedAtDbMs: state.clock.value, fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1",
      legacyWritersDrainedAck: input.legacyWritersDrainedAck, producerReadyAck: input.producerReadyAck }, history, checkpoint, key);
    return cutover;
  };
  const maintenance = Object.freeze({
    getTenantRestoreReplayRun: vi.fn((id: string) => state.store.getTenantRestoreReplayRun(id)),
    getTenantRestoreReplaySealedTargets: vi.fn((id: string) => state.store.getTenantRestoreReplaySealedTargets(id)),
    listTenantRestoreReplayEntries: vi.fn(state.store.listTenantRestoreReplayEntries.bind(state.store)),
    recordTenantRestoreReplayFence: vi.fn(state.store.recordTenantRestoreReplayFence.bind(state.store)),
    sealTenantRestoreReplay: vi.fn(state.store.sealTenantRestoreReplay.bind(state.store)),
    abortTenantRestoreReplay: vi.fn(state.store.abortTenantRestoreReplay.bind(state.store)),
    getTenantRestoreReplayReceipt: vi.fn((id: string) => state.store.getTenantRestoreReplayReceipt(id)),
    getTenantRestoreRuntimeControl: vi.fn(() => state.store.getTenantRestoreRuntimeControl()),
    getTenantRestoreRuntimeHeads: vi.fn(() => state.store.getTenantRestoreRuntimeHeads()),
    activateTenantRestoreRuntime: vi.fn(doActivate),
    getTenantRestoreJournalControl: vi.fn(() => state.store.getTenantRestoreJournalControl()),
    getTenantRestoreJournalControlTargets: vi.fn(() => state.store.getTenantRestoreJournalControlTargets()),
    getTenantBackupRestoreSourceBinding: vi.fn((id: string) => state.store.getTenantBackupRestoreSourceBinding(id)),
    getTenantBackupRuntimeReservation: vi.fn((id: string) => state.store.getTenantBackupRuntimeReservation(id)),
    resolveTenantBackupRuntimeReservation: vi.fn(state.store.resolveTenantBackupRuntimeReservation.bind(state.store)),
    getTenantTelemetryCaptureRestoreHistoryReceipt: vi.fn(async () => history),
    activateTenantTelemetryCaptureRestoredEpoch: vi.fn(doCutover),
    getTenantTelemetryCaptureEpochCutoverReceipt: vi.fn(async () => cutover),
    confirmSessionAuthorityBinding: vi.fn(async () => {
      assertHeld();
      if (!authorityContext || maintenanceProfile?.kind !== "operator-maintenance"
        || maintenanceProfile.binding !== authorityContext) throw new Error("synthetic_authority_profile_missing");
      const fixed = captureSessionAuthorityBindingCommand(authorityContext.command);
      const actual = await state.store.getTenantRestoreRuntimeControl();
      const run = await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID);
      if (fixed.nextEpoch?.kind !== "restore_activation" || actual.state !== "active" || actual.lineageKind !== "restore"
        || actual.runtimeEpochSha256 !== fixed.nextEpoch.runtimeEpochSha256 || run?.phase !== "active"
        || run.restoreRunId !== fixed.nextEpoch.restoreRunId || run.terminalReceiptSha256 !== fixed.nextEpoch.sealedReplayReceiptSha256
        || observedActivationRequestSha256 !== fixed.nextEpoch.activationRequestSha256) {
        throw new Error("synthetic_authority_confirmation_unknown");
      }
      expect(nativeAdmission).not.toHaveBeenCalled(); // Never mistake this Memory confirmation for native proof.
    }),
    close: vi.fn(async () => {}),
  } satisfies TenantTelemetryCaptureRestoreMaintenance);
  state.rememberFacade(maintenance, SELECTED_TARGET_URL);
  const bootstrap = vi.fn(async (
    options: Parameters<NonNullable<BackupCatalogCliDependencies["connectCaptureArtifactRestoreMaintenance"]>>[0],
    profile: Parameters<NonNullable<BackupCatalogCliDependencies["connectCaptureArtifactRestoreMaintenance"]>>[1],
  ): Promise<TenantTelemetryCaptureRestoreMaintenance> => {
    assertHeld(); expect(options.url).toBe(SELECTED_TARGET_URL);
    expect(options.operationAbortSignal).toBeInstanceOf(AbortSignal);
    if (profile.kind === "operator-maintenance") {
      expect(authorityContext).toBeDefined(); expect(profile.binding).toBe(authorityContext);
      expect(profile.binding.schemaMetadata).toEqual(SCHEMA_METADATA);
      expect(profile.binding.command).toBe(authorityContext!.command);
    } else expect(profile).toEqual(STOPPED_PROFILE);
    maintenanceProfile = profile; return maintenance;
  });
  state.dependencies.connectCaptureArtifactRestoreMaintenance = bootstrap;
  const keys: Buffer[] = [];
  state.dependencies.readRefKey = async () => { const copy = Buffer.from(key); keys.push(copy); return copy; };
  const env = (extra: NodeJS.ProcessEnv = {}) => artifactEnv({
    BACKUP_RESTORE_TARGET_MYSQL_URL: SELECTED_TARGET_URL, RESTORE_RUN_ID, BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID,
    TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/selection-ref-key",
    BACKUP_RESTORE_REPLAY_ACK: "1", BACKUP_RESTORE_VERIFY_ACK: "1", BACKUP_RESTORE_RUNTIME_ACTIVATION_ACK: "1",
    BACKUP_RESTORE_CATALOG_RESOLUTION_ACK: "1",
    TELEMETRY_CAPTURE_RESTORED_EPOCH_ACTIVATION_ACK: "1", TELEMETRY_CAPTURE_LOCAL_ONLY_ACK: "1",
    TELEMETRY_CAPTURE_FLEET_STOPPED_ACK: "1", TELEMETRY_CAPTURE_LEGACY_WRITERS_DRAINED_ACK: "1",
    TELEMETRY_CAPTURE_PRODUCER_READY_ACK: "1", TELEMETRY_CAPTURE_CONFIGURED_FLEET_ROOT_SHA256: sha256("selection-fleet"), ...extra });
  const authorityEnv = Object.freeze({ AUTHORITY_MYSQL_URL: SELECTED_TARGET_URL,
    AUTHORITY_COMMAND_FILE: "/private/selection-authority-command.json",
    AUTHORITY_FLEET_STOPPED_ACK: "all-application-writers-stopped-v1",
    AUTHORITY_EXCLUSIVE_CHANGE_ACK: "exclusive-authority-permissions-window-v1",
    AUTHORITY_METADATA_SCHEMA: SCHEMA_METADATA.metadataSchema,
    AUTHORITY_METADATA_DEFINER_USER: SCHEMA_METADATA.trustedDefiner.user,
    AUTHORITY_METADATA_DEFINER_HOST: SCHEMA_METADATA.trustedDefiner.host });
  const invoke = (command: string, extra: NodeJS.ProcessEnv = {}) => {
    artifacts.operator.close.mockClear(); artifacts.verifiedClose.mockClear(); maintenance.close.mockClear();
    state.output.length = 0;
    // Fixed operator environment is scoped to this independent activation only.
    return runBackupCatalogCli([command], env({ ...(command === "activate-selected" ? authorityEnv : {}), ...extra }), state.dependencies);
  };
  state.connectStore.mockClear(); state.output.length = 0;
  artifacts.create.mockClear(); artifacts.imported.mockClear();
  return { state, artifacts, maintenance, checkpoint, manifest, prepared, bootstrap, keys, env, invoke, doActivate, doCutover, assertHeld,
    loadAuthorityContext, nativeAdmission, authorityEnv, getAuthorityContext: () => authorityContext };
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

describe("authenticated capture selected continuation CLI orchestration (not source-audit proof)", () => {
  it.each([2, 3] as const)("separates ASMYSQL%s replay, seal, runtime activation and explicit capture cutover without reserve/import/general startup", async (version) => {
    const h = await selectedContinuationHarness(version);
    const reserve = vi.spyOn(h.state.catalogAdapter, "reserveRestore"), prepare = vi.spyOn(h.state.store, "prepareTenantRestoreReplayFromBackup");
    await h.invoke("replay-selected", { SOURCE_BACKUP_SHA256: sha256("caller-hash-must-be-ignored") });
    expect(h.maintenance.recordTenantRestoreReplayFence).toHaveBeenCalledOnce();
    expect(h.maintenance.sealTenantRestoreReplay).not.toHaveBeenCalled();
    expect(h.maintenance.activateTenantRestoreRuntime).not.toHaveBeenCalled();
    expect(h.maintenance.activateTenantTelemetryCaptureRestoredEpoch).not.toHaveBeenCalled();
    expect(JSON.parse(h.state.output[0]!)).toMatchObject({ restorePhase: "prepared", runtimeActivated: false, importAttempted: false });
    await h.invoke("verify-selected");
    expect(h.maintenance.sealTenantRestoreReplay).toHaveBeenCalledOnce();
    expect(h.maintenance.activateTenantRestoreRuntime).not.toHaveBeenCalled();
    await h.invoke("activate-selected");
    expect(h.maintenance.activateTenantRestoreRuntime).toHaveBeenCalledOnce();
    expect(h.maintenance.confirmSessionAuthorityBinding).toHaveBeenCalledOnce();
    expect(h.maintenance.confirmSessionAuthorityBinding.mock.invocationCallOrder[0])
      .toBeGreaterThan(h.maintenance.activateTenantRestoreRuntime.mock.invocationCallOrder[0]!);
    expect(h.nativeAdmission).not.toHaveBeenCalled();
    expect(h.maintenance.activateTenantTelemetryCaptureRestoredEpoch).not.toHaveBeenCalled();
    expect(JSON.parse(h.state.output[0]!)).toMatchObject({ restorePhase: "active", runtimeActivated: true,
      captureCutoverConfirmed: false, requiresExplicitCatalogResolution: true });
    expect(JSON.parse(h.state.output[0]!)).not.toHaveProperty("captureWritesAuthorized");
    await h.invoke("activate-capture-selected");
    expect(h.maintenance.activateTenantTelemetryCaptureRestoredEpoch).toHaveBeenCalledWith({
      expectedRuntimeEpochSha256: tenantRestoreRuntimeEpochSha256(RESTORE_EPOCH_ID), configuredFleetRootSha256: sha256("selection-fleet"),
      legacyWritersDrainedAck: "legacy-writers-drained-v1", producerReadyAck: "provider-step-error-v2-ready-v1" });
    expect(JSON.parse(h.state.output[0]!)).toMatchObject({ captureWritesAuthorized: true,
      historicalOperationRecoveryAuthorized: false, allDomainsComplete: false, contentPurgeExecuted: false });
    expect(h.state.connectStore).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    expect(h.artifacts.imported).not.toHaveBeenCalled(); expect(h.artifacts.create).not.toHaveBeenCalled();
    expect(h.artifacts.operator.bindRestoreOperation).not.toHaveBeenCalled();
    expect(h.artifacts.acquire.mock.calls.at(-1)?.[0]).toMatchObject({ sourceUrl: SELECTED_TARGET_URL });
    expect(h.artifacts.acquire.mock.calls.at(-1)?.[0]).not.toHaveProperty("targetUrl");
    const selection = h.bootstrap.mock.calls.at(-1)![0].selection;
    expect(Object.keys(selection).sort()).toEqual(["backupId", "restoreRunId", "checkpointSha256", "artifactManifestSha256",
      "sourceSnapshotSha256", "providerEvidenceSha256", "fleetStoppedAck", "localOnlyAck"].sort());
    expect(selection).toMatchObject({ checkpointSha256: h.checkpoint.checkpointSha256,
      artifactManifestSha256: h.artifacts.evidence.artifactManifestSha256, sourceSnapshotSha256: h.artifacts.evidence.sourceSnapshotSha256 });
    expect(h.keys.every((key) => key.every((byte) => byte === 0))).toBe(true);
  });

  it.each([
    ["replay-selected", "BACKUP_RESTORE_REPLAY_ACK"], ["verify-selected", "BACKUP_RESTORE_VERIFY_ACK"],
    ["activate-selected", "BACKUP_RESTORE_RUNTIME_ACTIVATION_ACK"],
    ["activate-capture-selected", "TELEMETRY_CAPTURE_RESTORED_EPOCH_ACTIVATION_ACK"],
    ["resolve-selected", "BACKUP_RESTORE_CATALOG_RESOLUTION_ACK"],
  ])("requires %s's independent explicit acknowledgement before any resource or external probe", async (command, ack) => {
    const h = await selectedContinuationHarness();
    h.artifacts.acquire.mockClear(); h.artifacts.verify.mockClear(); h.state.createCatalogAdapter.mockClear();
    await expect(h.invoke(command!, { [ack!]: undefined })).rejects.toThrow();
    expect(h.artifacts.acquire).not.toHaveBeenCalled(); expect(h.artifacts.verify).not.toHaveBeenCalled();
    expect(h.bootstrap).not.toHaveBeenCalled(); expect(h.state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(h.keys).toHaveLength(0);
  });
  it.each(["production", "missing-key", "missing-bootstrap"] as const)("rejects %s before authenticated continuation can touch an external target", async (kind) => {
    const h = await selectedContinuationHarness();
    h.artifacts.acquire.mockClear(); h.artifacts.verify.mockClear(); h.state.createCatalogAdapter.mockClear();
    if (kind === "missing-bootstrap") delete h.state.dependencies.connectCaptureArtifactRestoreMaintenance;
    await expect(h.invoke("replay-selected", kind === "production" ? { NODE_ENV: "production" }
      : kind === "missing-key" ? { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: undefined } : {})).rejects.toThrow();
    expect(h.artifacts.acquire).not.toHaveBeenCalled(); expect(h.artifacts.verify).not.toHaveBeenCalled();
    expect(h.state.createCatalogAdapter).not.toHaveBeenCalled(); expect(h.keys).toHaveLength(0);
  });
  it("rejects missing capture facade capability before conditional external startup probes", async () => {
    const h = await selectedContinuationHarness();
    const invalidFacade = { ...h.maintenance }; Reflect.deleteProperty(invalidFacade, "activateTenantTelemetryCaptureRestoredEpoch");
    h.state.rememberFacade(invalidFacade, SELECTED_TARGET_URL); // Reach the original missing-capability boundary, not a binding failure.
    h.bootstrap.mockResolvedValueOnce(invalidFacade); h.state.createCatalogAdapter.mockClear();
    await expect(h.invoke("activate-capture-selected")).rejects.toThrow();
    expect(h.state.createCatalogAdapter).not.toHaveBeenCalled(); expect(h.maintenance.close).toHaveBeenCalledOnce();
    expect(h.artifacts.imported).not.toHaveBeenCalled();
  });
  it("does not upgrade a v1 authenticated artifact into a v2 maintenance selection", async () => {
    const h = await selectedContinuationHarness(); h.state.createCatalogAdapter.mockClear();
    h.artifacts.verify.mockResolvedValueOnce({ manifest: { ...h.manifest, version: 1 } as typeof h.manifest,
      evidence: h.artifacts.evidence, close: h.artifacts.verifiedClose });
    await expect(h.invoke("replay-selected")).rejects.toThrow();
    expect(h.bootstrap).not.toHaveBeenCalled(); expect(h.state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(h.maintenance.recordTenantRestoreReplayFence).not.toHaveBeenCalled();
  });
  it.each(["TELEMETRY_CAPTURE_LEGACY_WRITERS_DRAINED_ACK", "TELEMETRY_CAPTURE_PRODUCER_READY_ACK",
    "TELEMETRY_CAPTURE_CONFIGURED_FLEET_ROOT_SHA256"])("rejects missing capture %s before any external startup probe", async (field) => {
    const h = await selectedContinuationHarness(); h.artifacts.acquire.mockClear(); h.state.createCatalogAdapter.mockClear();
    await expect(h.invoke("activate-capture-selected", { [field]: undefined })).rejects.toThrow();
    expect(h.artifacts.acquire).not.toHaveBeenCalled(); expect(h.state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(h.maintenance.activateTenantTelemetryCaptureRestoredEpoch).not.toHaveBeenCalled();
  });
  it("refuses lost target named-lock ownership after authentication and before exposing any maintenance capability", async () => {
    const h = await selectedContinuationHarness(); h.state.createCatalogAdapter.mockClear();
    h.artifacts.operator.assertHeld.mockRejectedValueOnce(new Error(RESPONSE_LOSS_MARKER));
    await expect(h.invoke("replay-selected")).rejects.toThrow();
    expect(h.bootstrap).not.toHaveBeenCalled(); expect(h.state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(h.maintenance.recordTenantRestoreReplayFence).not.toHaveBeenCalled();
    expect(h.artifacts.operator.close).toHaveBeenCalledOnce(); expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce();
  });
  it("compares actual authenticated evidence to the sealed catalog rather than caller hashes", async () => {
    const h = await selectedContinuationHarness();
    h.artifacts.verify.mockResolvedValueOnce({ manifest: h.manifest,
      evidence: { ...h.artifacts.evidence, sourceBackupSha256: sha256("wrong-authenticated-bytes") }, close: h.artifacts.verifiedClose });
    await expect(h.invoke("replay-selected")).rejects.toThrow();
    expect(h.maintenance.recordTenantRestoreReplayFence).not.toHaveBeenCalled(); expect(h.artifacts.imported).not.toHaveBeenCalled();
  });
  it("requires the actual target reservation to match the exact sealed external reservation", async () => {
    const h = await selectedContinuationHarness();
    h.maintenance.getTenantBackupRuntimeReservation.mockResolvedValueOnce({ ...h.prepared.value.reservation,
      reservationReceiptSha256: sha256("another-reservation") });
    await expect(h.invoke("replay-selected")).rejects.toThrow();
    expect(h.maintenance.recordTenantRestoreReplayFence).not.toHaveBeenCalled();
  });
  it("replays the identical fence after committed response loss without creating another operation", async () => {
    const h = await selectedContinuationHarness();
    const record = h.state.store.recordTenantRestoreReplayFence.bind(h.state.store);
    h.maintenance.recordTenantRestoreReplayFence.mockImplementationOnce(async (input) => { h.assertHeld(); await record(input); throw new Error(RESPONSE_LOSS_MARKER); });
    await h.invoke("replay-selected");
    expect(h.maintenance.recordTenantRestoreReplayFence).toHaveBeenCalledTimes(2);
    expect(h.maintenance.recordTenantRestoreReplayFence.mock.calls[0]).toEqual(h.maintenance.recordTenantRestoreReplayFence.mock.calls[1]);
    expect((await h.state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))?.entryCount).toBe(1);
    expect(h.state.output.join("")).not.toContain(RESPONSE_LOSS_MARKER);
  });
  it("proves a seal's lost response from the exact full durable receipt and run", async () => {
    const h = await selectedContinuationHarness(); await h.invoke("replay-selected");
    h.maintenance.sealTenantRestoreReplay.mockImplementationOnce(async (id) => { await h.state.store.sealTenantRestoreReplay(id); throw new Error(RESPONSE_LOSS_MARKER); });
    await h.invoke("verify-selected");
    expect(JSON.parse(h.state.output[0]!)).toMatchObject({ restorePhase: "replay_sealed", runtimeActivated: false });
    expect(h.maintenance.activateTenantRestoreRuntime).not.toHaveBeenCalled();
  });
  it("proves runtime activation response loss from history, run, receipt, runtime and fresh external heads", async () => {
    const h = await selectedContinuationHarness(); await h.invoke("replay-selected"); await h.invoke("verify-selected");
    h.maintenance.activateTenantRestoreRuntime.mockImplementationOnce(async (input) => { await h.doActivate(input); throw new Error(RESPONSE_LOSS_MARKER); });
    await h.invoke("activate-selected");
    expect(JSON.parse(h.state.output[0]!)).toMatchObject({ runtimeActivated: true, captureCutoverConfirmed: false,
      requiresExplicitCatalogResolution: true });
    expect(h.maintenance.activateTenantRestoreRuntime).toHaveBeenCalledOnce();
    expect(h.maintenance.activateTenantTelemetryCaptureRestoredEpoch).not.toHaveBeenCalled();
    const fixed = h.getAuthorityContext()!.command;
    await h.invoke("activate-selected"); // Exact durable replay is a read, not another activation.
    expect(h.getAuthorityContext()!.command).toBe(fixed);
    expect(h.maintenance.activateTenantRestoreRuntime).toHaveBeenCalledOnce();
    expect(h.maintenance.confirmSessionAuthorityBinding).toHaveBeenCalledTimes(2);
    expect(h.nativeAdmission).not.toHaveBeenCalled();
  });
  it("proves capture response loss only by an exact durable cutover receipt", async () => {
    const h = await selectedContinuationHarness(); await h.invoke("replay-selected"); await h.invoke("verify-selected"); await h.invoke("activate-selected");
    h.maintenance.activateTenantTelemetryCaptureRestoredEpoch.mockImplementationOnce(async (input) => { await h.doCutover(input); throw new Error(RESPONSE_LOSS_MARKER); });
    await h.invoke("activate-capture-selected");
    expect(JSON.parse(h.state.output[0]!)).toMatchObject({ captureWritesAuthorized: true, historicalOperationRecoveryAuthorized: false });
  });
  it("does not capture-cutover a merely prepared run even with all explicit acknowledgements", async () => {
    const h = await selectedContinuationHarness(); await expect(h.invoke("activate-capture-selected")).rejects.toThrow();
    expect(h.maintenance.activateTenantTelemetryCaptureRestoredEpoch).not.toHaveBeenCalled();
    expect(h.maintenance.activateTenantRestoreRuntime).not.toHaveBeenCalled();
  });
  it("refuses fresh journal-head drift before runtime activation", async () => {
    const h = await selectedContinuationHarness(); await h.invoke("replay-selected"); await h.invoke("verify-selected");
    const prior = await h.state.journalDelegate.readHead();
    vi.spyOn(h.state.journalAdapter, "readHead").mockResolvedValue({ ...prior,
      remoteSequence: prior.remoteSequence + 1, headRootSha256: sha256("fresh-head-changed") });
    await expect(h.invoke("activate-selected")).rejects.toThrow();
    expect(h.maintenance.activateTenantRestoreRuntime).not.toHaveBeenCalled();
  });
  it("cannot treat an empty forged nonzero scan page as a successful replay", async () => {
    const h = await selectedContinuationHarness();
    const head = await h.state.journalDelegate.readHead();
    vi.spyOn(h.state.journalAdapter, "scanRecords").mockResolvedValue({ entries: [], nextRemoteSequence: head.remoteSequence,
      nextHeadRootSha256: head.headRootSha256, complete: true });
    await expect(h.invoke("replay-selected")).rejects.toThrow();
    expect(h.maintenance.recordTenantRestoreReplayFence).not.toHaveBeenCalled(); expect(h.state.output).toHaveLength(0);
  });
  it("reports ambiguous committed activation honestly when full history proof is unavailable", async () => {
    const h = await selectedContinuationHarness(); await h.invoke("replay-selected"); await h.invoke("verify-selected");
    h.maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt.mockResolvedValue(null);
    let failure: unknown; try { await h.invoke("activate-selected"); } catch (error) { failure = error; }
    const formatted = JSON.parse(formatBackupCatalogCliError(failure));
    expect(formatted).toMatchObject({ status: "error", restoreMutationMayBeCommitted: true,
      runtimeActivationMayBeCommitted: true, captureActivationMayBeCommitted: false, requiresExactReplay: true, importAttempted: false });
    expect(formatted).not.toHaveProperty("runtimeActivated"); expect(h.state.output).toHaveLength(0);
    expect((await h.state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))?.phase).toBe("active");
  });
  it("retains artifact/key/operator ownership until a late artifact-bootstrap result has really closed", async () => {
    const h = await selectedContinuationHarness(); let elapsed = 0;
    h.state.dependencies.now = () => elapsed;
    let resolveFactory: ((value: TenantTelemetryCaptureRestoreMaintenance) => void) | undefined;
    let entered!: () => void; const factoryEntered = new Promise<void>((resolve) => { entered = resolve; });
    h.bootstrap.mockImplementationOnce(() => { h.assertHeld(); entered(); return new Promise((resolve) => { resolveFactory = resolve; }); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = h.invoke("replay-selected", { BACKUP_ARTIFACT_DEADLINE_MS: "1000" });
      const result = pending.then(() => ({ unexpected: true }), (error: unknown) => ({ error }));
      await factoryEntered; elapsed = 1_001; await vi.advanceTimersByTimeAsync(1_001); await vi.advanceTimersByTimeAsync(250);
      await expect(result).resolves.toMatchObject({ error: { code: "operation_deadline" } });
      expect(h.bootstrap.mock.calls[0]![0].operationAbortSignal?.aborted).toBe(true);
      h.assertHeld(); expect(h.keys[0]!.every((byte) => byte === 0x43)).toBe(true);
      expect(h.maintenance.close).not.toHaveBeenCalled(); expect(h.state.createCatalogAdapter).toHaveBeenCalledTimes(2); // Only setup.
      resolveFactory!(h.maintenance);
      await vi.waitFor(() => { expect(h.maintenance.close).toHaveBeenCalledOnce(); expect(h.artifacts.operator.close).toHaveBeenCalledOnce();
        expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce(); expect(h.keys[0]!.every((byte) => byte === 0)).toBe(true); });
      expect(h.maintenance.close.mock.invocationCallOrder[0]).toBeLessThan(h.artifacts.operator.close.mock.invocationCallOrder[0]!);
      expect(h.maintenance.recordTenantRestoreReplayFence).not.toHaveBeenCalled(); expect(h.state.output).toHaveLength(0);
    } finally { resolveFactory?.(h.maintenance); await vi.runAllTimersAsync(); vi.useRealTimers(); }
  });
  it("accepts continuation native closes fulfilled during the existing drain window after the first cleanup wait", async () => {
    const h = await selectedContinuationHarness();
    const reserve = vi.spyOn(h.state.catalogAdapter, "reserveRestore");
    let resolveClose: (() => void) | undefined;
    let entered!: () => void; const closeStarted = new Promise<void>((resolve) => { entered = resolve; });
    const closeFulfilled = vi.fn(() => {});
    h.maintenance.close.mockImplementationOnce(async () => {
      entered(); await new Promise<void>((resolve) => { resolveClose = resolve; }); closeFulfilled();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let invocationSettled = false;
      const result = h.invoke("replay-selected").then(
        (status) => { invocationSettled = true; return { status }; },
        (error: unknown) => { invocationSettled = true; return { error }; },
      );
      await closeStarted; await vi.advanceTimersByTimeAsync(250);
      expect(invocationSettled).toBe(false); h.assertHeld();
      expect(h.keys[0]!.every((byte) => byte === 0x43)).toBe(true);
      expect(h.state.output).toHaveLength(0); expect(closeFulfilled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50); resolveClose!();
      await expect(result).resolves.toEqual({ status: 0 });
      expect(h.maintenance.close).toHaveBeenCalledOnce(); expect(closeFulfilled).toHaveBeenCalledOnce();
      expect(h.artifacts.operator.close).toHaveBeenCalledOnce(); expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce();
      expect(closeFulfilled.mock.invocationCallOrder[0]).toBeLessThan(h.artifacts.operator.close.mock.invocationCallOrder[0]!);
      expect(closeFulfilled.mock.invocationCallOrder[0]).toBeLessThan(h.artifacts.verifiedClose.mock.invocationCallOrder[0]!);
      expect(h.keys[0]!.every((byte) => byte === 0)).toBe(true);
      expect(h.state.output).toHaveLength(1);
      expect(JSON.parse(h.state.output[0]!)).toMatchObject({ status: "ok", command: "replay-selected",
        restorePhase: "prepared", runtimeActivated: false, importAttempted: false });
      expect(h.maintenance.recordTenantRestoreReplayFence).toHaveBeenCalledOnce();
      expect(reserve).not.toHaveBeenCalled(); expect(h.artifacts.imported).not.toHaveBeenCalled();
    } finally { resolveClose?.(); await vi.runAllTimersAsync(); vi.useRealTimers(); }
  });

  it("keeps a continuation native close rejection as failure when the remaining close fulfills during the drain window", async () => {
    const h = await selectedContinuationHarness();
    vi.mocked(h.state.journalAdapter.close).mockClear();
    h.maintenance.close.mockRejectedValueOnce(new Error(RESPONSE_LOSS_MARKER));
    let resolveJournal: (() => void) | undefined;
    let entered!: () => void; const closeStarted = new Promise<void>((resolve) => { entered = resolve; });
    const closeFulfilled = vi.fn(() => {});
    vi.mocked(h.state.journalAdapter.close).mockImplementationOnce(async () => {
      entered(); await new Promise<void>((resolve) => { resolveJournal = resolve; }); closeFulfilled();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let invocationSettled = false;
      const result = h.invoke("replay-selected").then(
        (status) => { invocationSettled = true; return { status }; },
        (error: unknown) => { invocationSettled = true; return { error }; },
      );
      await closeStarted; await vi.advanceTimersByTimeAsync(250);
      expect(invocationSettled).toBe(false); h.assertHeld();
      expect(h.keys[0]!.every((byte) => byte === 0x43)).toBe(true);
      expect(h.state.output).toHaveLength(0); expect(closeFulfilled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50); resolveJournal!();
      await expect(result).resolves.toMatchObject({ error: { code: "operation_failed",
        selectedBoundary: { restoreMutationMayBeCommitted: true } } });
      expect(h.maintenance.close).toHaveBeenCalledOnce(); expect(h.state.journalAdapter.close).toHaveBeenCalledOnce();
      expect(closeFulfilled).toHaveBeenCalledOnce();
      expect(h.artifacts.operator.close).toHaveBeenCalledOnce(); expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce();
      expect(closeFulfilled.mock.invocationCallOrder[0]).toBeLessThan(h.artifacts.operator.close.mock.invocationCallOrder[0]!);
      expect(closeFulfilled.mock.invocationCallOrder[0]).toBeLessThan(h.artifacts.verifiedClose.mock.invocationCallOrder[0]!);
      expect(h.keys[0]!.every((byte) => byte === 0)).toBe(true); expect(h.state.output).toHaveLength(0);
    } finally { resolveJournal?.(); await vi.runAllTimersAsync(); vi.useRealTimers(); }
  });

  it("all-settles a failed maintenance close and a still-live journal close before releasing continuation locks", async () => {
    const h = await selectedContinuationHarness();
    h.maintenance.close.mockRejectedValueOnce(new Error(RESPONSE_LOSS_MARKER));
    let resolveJournal: (() => void) | undefined;
    let entered!: () => void; const journalClosing = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(h.state.journalAdapter.close).mockImplementationOnce(() => {
      entered(); return new Promise<void>((resolve) => { resolveJournal = resolve; });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = h.invoke("replay-selected");
      const result = pending.then(() => ({ unexpected: true }), (error: unknown) => ({ error }));
      await journalClosing; await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toMatchObject({ error: { code: "operation_failed",
        selectedBoundary: { restoreMutationMayBeCommitted: true } } });
      h.assertHeld(); expect(h.keys[0]!.every((byte) => byte === 0x43)).toBe(true); expect(h.state.output).toHaveLength(0);
      resolveJournal!();
      await vi.waitFor(() => { expect(h.artifacts.operator.close).toHaveBeenCalledOnce();
        expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce(); expect(h.keys[0]!.every((byte) => byte === 0)).toBe(true); });
      expect(h.maintenance.close).toHaveBeenCalledOnce();
    } finally { resolveJournal?.(); await vi.runAllTimersAsync(); vi.useRealTimers(); }
  });
});

describe("explicit authenticated capture selected catalog resolution (orchestration doubles only)", () => {
  const activeSelection = async (capture = true, version: 2 | 3 = 2) => {
    const h = await selectedContinuationHarness(version);
    await h.invoke("replay-selected"); await h.invoke("verify-selected"); await h.invoke("activate-selected");
    if (capture) await h.invoke("activate-capture-selected");
    h.maintenance.activateTenantRestoreRuntime.mockClear(); h.maintenance.activateTenantTelemetryCaptureRestoredEpoch.mockClear();
    return h;
  };

  it.each([2, 3] as const)("independently resolves ASMYSQL%s external CAS then exact local projection under held GCM/target ownership, and replays exactly", async (version) => {
    const h = await activeSelection(true, version);
    const reserve = vi.spyOn(h.state.catalogAdapter, "reserveRestore");
    const prepare = vi.spyOn(h.state.store, "prepareTenantRestoreReplayFromBackup");
    const scan = vi.spyOn(h.state.catalogAdapter, "scanEvents");
    const cas = vi.spyOn(h.state.catalogAdapter, "resolveRestore").mockImplementation(async (input) => {
      h.assertHeld(); expect(h.keys.at(-1)!.every((byte) => byte === 0x43)).toBe(true);
      return h.state.catalogDelegate.resolveRestore(input);
    });
    h.maintenance.resolveTenantBackupRuntimeReservation.mockImplementation(async (input) => {
      h.assertHeld(); return h.state.store.resolveTenantBackupRuntimeReservation(input);
    });
    await h.invoke("resolve-selected", { SOURCE_BACKUP_SHA256: sha256("untrusted-caller-hash-is-not-used") });
    expect(cas).toHaveBeenCalledWith({ restoreRunId: RESTORE_RUN_ID,
      reservationReceiptSha256: h.prepared.value.reservation.reservationReceiptSha256, phase: "activated" });
    expect(h.maintenance.resolveTenantBackupRuntimeReservation).toHaveBeenCalledOnce();
    const casOrder = cas.mock.invocationCallOrder[0]!, projectionOrder = h.maintenance.resolveTenantBackupRuntimeReservation.mock.invocationCallOrder[0]!;
    expect(casOrder).toBeLessThan(projectionOrder);
    expect(scan.mock.invocationCallOrder.some((order) => order > casOrder && order < projectionOrder)).toBe(true);
    expect(h.maintenance.getTenantTelemetryCaptureEpochCutoverReceipt.mock.invocationCallOrder.at(-1)!).toBeLessThan(casOrder);
    expect(JSON.parse(h.state.output[0]!)).toMatchObject({ command: "resolve-selected", restorePhase: "active", phase: "activated",
      disposition: "created", catalogResolutionConfirmed: true, requiresExplicitCatalogResolution: false,
      runtimeActivated: true, captureCutoverConfirmed: false, historicalOperationRecoveryAuthorized: false,
      allDomainsComplete: false, contentPurgeExecuted: false, importAttempted: false });
    expect(JSON.parse(h.state.output[0]!)).not.toHaveProperty("captureWritesAuthorized");
    expect(h.maintenance.activateTenantRestoreRuntime).not.toHaveBeenCalled();
    expect(h.maintenance.activateTenantTelemetryCaptureRestoredEpoch).not.toHaveBeenCalled();
    expect(h.state.connectStore).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    expect(h.artifacts.imported).not.toHaveBeenCalled(); expect(h.artifacts.create).not.toHaveBeenCalled();
    expect(h.artifacts.acquire.mock.calls.at(-1)![0]).toMatchObject({ sourceUrl: SELECTED_TARGET_URL });
    expect(h.artifacts.acquire.mock.calls.at(-1)![0]).not.toHaveProperty("targetUrl");
    const first = await h.state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID);
    const head = await h.state.catalogDelegate.readHead();
    await h.invoke("resolve-selected");
    expect(JSON.parse(h.state.output[0]!)).toMatchObject({ disposition: "exact_replay", phase: "activated",
      catalogResolutionConfirmed: true, requiresExplicitCatalogResolution: false });
    expect(await h.state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID)).toEqual(first);
    expect(await h.state.catalogDelegate.readHead()).toEqual(head);
    expect(h.keys.every((key) => key.every((byte) => byte === 0))).toBe(true);
  });

  it.each(["bootstrap", "resolution-method"] as const)("rejects missing %s before external startup or resolution CAS", async (kind) => {
    const h = await selectedContinuationHarness();
    const cas = vi.spyOn(h.state.catalogAdapter, "resolveRestore");
    h.artifacts.acquire.mockClear(); h.state.createCatalogAdapter.mockClear();
    if (kind === "bootstrap") delete h.state.dependencies.connectCaptureArtifactRestoreMaintenance;
    else {
      const incomplete = { ...h.maintenance }; Reflect.deleteProperty(incomplete, "resolveTenantBackupRuntimeReservation");
      h.state.rememberFacade(incomplete, SELECTED_TARGET_URL); // Keep this a capability-negative oracle.
      h.bootstrap.mockResolvedValueOnce(incomplete);
    }
    await expect(h.invoke("resolve-selected")).rejects.toThrow();
    expect(h.state.createCatalogAdapter).not.toHaveBeenCalled(); expect(cas).not.toHaveBeenCalled();
    expect(h.maintenance.resolveTenantBackupRuntimeReservation).not.toHaveBeenCalled();
    if (kind === "bootstrap") expect(h.artifacts.acquire).not.toHaveBeenCalled();
  });

  it("refuses history-only runtime activation before consuming external resolution authority", async () => {
    const h = await activeSelection(false);
    const cas = vi.spyOn(h.state.catalogAdapter, "resolveRestore");
    await expect(h.invoke("resolve-selected")).rejects.toThrow();
    expect(h.maintenance.getTenantTelemetryCaptureEpochCutoverReceipt).toHaveBeenCalledOnce();
    expect(cas).not.toHaveBeenCalled(); expect(h.maintenance.resolveTenantBackupRuntimeReservation).not.toHaveBeenCalled();
    expect((await h.state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID))?.phase).toBe("reserved");
    expect(h.state.output).toHaveLength(0);
  });

  it.each(["prepared", "replay_sealed"] as const)("does not resolve or automatically activate a %s run", async (phase) => {
    const h = await selectedContinuationHarness();
    if (phase === "replay_sealed") { await h.invoke("replay-selected"); await h.invoke("verify-selected"); }
    const cas = vi.spyOn(h.state.catalogAdapter, "resolveRestore");
    await expect(h.invoke("resolve-selected")).rejects.toThrow();
    expect(cas).not.toHaveBeenCalled(); expect(h.maintenance.resolveTenantBackupRuntimeReservation).not.toHaveBeenCalled();
    expect(h.maintenance.activateTenantRestoreRuntime).not.toHaveBeenCalled();
    expect(h.maintenance.activateTenantTelemetryCaptureRestoredEpoch).not.toHaveBeenCalled();
  });

  it.each(["run", "authenticated-evidence", "target-reservation"] as const)("rejects wrong %s before external resolution CAS", async (kind) => {
    const h = await activeSelection(); const cas = vi.spyOn(h.state.catalogAdapter, "resolveRestore");
    if (kind === "authenticated-evidence") h.artifacts.verify.mockResolvedValueOnce({ manifest: h.manifest,
      evidence: { ...h.artifacts.evidence, sourceBackupSha256: sha256("wrong-selected-authenticated-bytes") }, close: h.artifacts.verifiedClose });
    if (kind === "target-reservation") h.maintenance.getTenantBackupRuntimeReservation.mockResolvedValueOnce({ ...h.prepared.value.reservation,
      reservationReceiptSha256: sha256("wrong-selected-target-reservation") });
    await expect(h.invoke("resolve-selected", kind === "run" ? { RESTORE_RUN_ID: "restore_00000000-0000-4000-8000-000000000099" } : {})).rejects.toThrow();
    expect(cas).not.toHaveBeenCalled(); expect(h.maintenance.resolveTenantBackupRuntimeReservation).not.toHaveBeenCalled();
    expect(h.state.output).toHaveLength(0);
  });

  it("refuses a forged empty full-chain scan before any resolution CAS", async () => {
    const h = await activeSelection(); const cas = vi.spyOn(h.state.catalogAdapter, "resolveRestore");
    const head = await h.state.catalogDelegate.readHead();
    vi.spyOn(h.state.catalogAdapter, "scanEvents").mockResolvedValue({ events: [], nextCatalogSequence: head.catalogSequence,
      nextCatalogEventRootSha256: head.catalogEventRootSha256, complete: true });
    await expect(h.invoke("resolve-selected")).rejects.toThrow();
    expect(cas).not.toHaveBeenCalled(); expect(h.maintenance.resolveTenantBackupRuntimeReservation).not.toHaveBeenCalled();
  });

  it.each([2, 3] as const)("returns ASMYSQL%s ambiguous external response loss and needs an explicit identical retry, without duplicate resolution", async (version) => {
    const h = await activeSelection(true, version);
    const cas = vi.spyOn(h.state.catalogAdapter, "resolveRestore").mockImplementationOnce(async (input) => {
      await h.state.catalogDelegate.resolveRestore(input); throw new Error(RESPONSE_LOSS_MARKER);
    });
    let failure: unknown; try { await h.invoke("resolve-selected"); } catch (error) { failure = error; }
    expect(JSON.parse(formatBackupCatalogCliError(failure))).toMatchObject({ status: "error", code: "operation_failed",
      restoreMutationMayBeCommitted: true, catalogResolutionMayBeCommitted: true, runtimeActivationMayBeCommitted: false,
      captureActivationMayBeCommitted: false, requiresExactReplay: true, importAttempted: false });
    expect(formatBackupCatalogCliError(failure)).not.toContain(RESPONSE_LOSS_MARKER);
    expect(h.state.output).toHaveLength(0); expect(h.maintenance.resolveTenantBackupRuntimeReservation).not.toHaveBeenCalled();
    expect((await h.state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID))?.phase).toBe("reserved");
    const head = await h.state.catalogDelegate.readHead();
    await h.invoke("resolve-selected");
    expect(cas).toHaveBeenCalledTimes(2); expect(cas.mock.calls[0]).toEqual(cas.mock.calls[1]);
    expect(await h.state.catalogDelegate.readHead()).toEqual(head);
    expect(JSON.parse(h.state.output[0]!)).toMatchObject({ disposition: "created", phase: "activated", requiresExplicitCatalogResolution: false });
  });

  it("returns ambiguous local response loss and explicitly replays the same external/local receipts", async () => {
    const h = await activeSelection(); const cas = vi.spyOn(h.state.catalogAdapter, "resolveRestore");
    h.maintenance.resolveTenantBackupRuntimeReservation.mockImplementationOnce(async (input) => {
      await h.state.store.resolveTenantBackupRuntimeReservation(input); throw new Error(RESPONSE_LOSS_MARKER);
    });
    let failure: unknown; try { await h.invoke("resolve-selected"); } catch (error) { failure = error; }
    expect(JSON.parse(formatBackupCatalogCliError(failure))).toMatchObject({ status: "error", catalogResolutionMayBeCommitted: true,
      requiresExactReplay: true, restoreMutationMayBeCommitted: true });
    expect(h.state.output).toHaveLength(0);
    const record = await h.state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID), head = await h.state.catalogDelegate.readHead();
    expect(record?.phase).toBe("activated");
    await h.invoke("resolve-selected");
    expect(cas).toHaveBeenCalledTimes(2); expect(cas.mock.calls[0]).toEqual(cas.mock.calls[1]);
    expect(h.maintenance.resolveTenantBackupRuntimeReservation).toHaveBeenCalledTimes(2);
    expect(h.maintenance.resolveTenantBackupRuntimeReservation.mock.calls[0]).toEqual(h.maintenance.resolveTenantBackupRuntimeReservation.mock.calls[1]);
    expect(await h.state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID)).toEqual(record);
    expect(await h.state.catalogDelegate.readHead()).toEqual(head);
    expect(JSON.parse(h.state.output[0]!)).toMatchObject({ disposition: "exact_replay", phase: "activated", catalogResolutionConfirmed: true });
  });

  it("never projects merely because CAS returned when its new event cannot be read from the complete actual chain", async () => {
    const h = await activeSelection(); let resolved = false;
    const scan = h.state.catalogAdapter.scanEvents.bind(h.state.catalogAdapter);
    vi.spyOn(h.state.catalogAdapter, "scanEvents").mockImplementation(async (options) => resolved
      ? { events: [], nextCatalogSequence: options.sealedHead.catalogSequence,
        nextCatalogEventRootSha256: options.sealedHead.catalogEventRootSha256, complete: true }
      : scan(options));
    vi.spyOn(h.state.catalogAdapter, "resolveRestore").mockImplementation(async (input) => {
      const value = await h.state.catalogDelegate.resolveRestore(input); resolved = true; return value;
    });
    let failure: unknown; try { await h.invoke("resolve-selected"); } catch (error) { failure = error; }
    expect(JSON.parse(formatBackupCatalogCliError(failure))).toMatchObject({ code: "catalog_corrupt",
      catalogResolutionMayBeCommitted: true, requiresExactReplay: true });
    expect(h.maintenance.resolveTenantBackupRuntimeReservation).not.toHaveBeenCalled();
    expect((await h.state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID))?.phase).toBe("reserved");
    expect(h.state.output).toHaveLength(0);
  });

  it("keeps GCM/key/target locks until a hung resolution CAS actually settles after the whole-operation deadline", async () => {
    const h = await activeSelection(); let elapsed = 0; h.state.dependencies.now = () => elapsed;
    type Result = Awaited<ReturnType<TenantBackupCatalogAdapter["resolveRestore"]>>;
    let resolveCas: ((value: Result) => void) | undefined;
    let entered!: () => void; const casEntered = new Promise<void>((resolve) => { entered = resolve; });
    const cas = vi.spyOn(h.state.catalogAdapter, "resolveRestore").mockImplementationOnce(() => {
      h.assertHeld(); entered(); return new Promise<Result>((resolve) => { resolveCas = resolve; });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = h.invoke("resolve-selected", { BACKUP_ARTIFACT_DEADLINE_MS: "1000" });
      const result = pending.then(() => ({ unexpected: true }), (error: unknown) => ({ error }));
      await casEntered; elapsed = 1_001; await vi.advanceTimersByTimeAsync(1_001); await vi.advanceTimersByTimeAsync(250);
      await expect(result).resolves.toMatchObject({ error: { code: "operation_deadline",
        selectedBoundary: { catalogResolutionMayBeCommitted: true } } });
      h.assertHeld(); expect(h.keys.at(-1)!.every((byte) => byte === 0x43)).toBe(true);
      expect(h.maintenance.resolveTenantBackupRuntimeReservation).not.toHaveBeenCalled(); expect(h.state.output).toHaveLength(0);
      const input = cas.mock.calls[0]![0], actual = await h.state.catalogDelegate.resolveRestore(input);
      resolveCas!(actual);
      await vi.waitFor(() => { expect(h.artifacts.operator.close).toHaveBeenCalledOnce();
        expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce(); expect(h.keys.at(-1)!.every((byte) => byte === 0)).toBe(true); });
      expect(h.maintenance.resolveTenantBackupRuntimeReservation).not.toHaveBeenCalled();
    } finally {
      if (resolveCas) resolveCas(await h.state.catalogDelegate.resolveRestore(cas.mock.calls[0]![0]));
      await vi.runAllTimersAsync(); vi.useRealTimers();
    }
  });
});

describe("backup catalog artifact CLI orchestration", () => {
  it("passes one protected exact key to source and restored target, then zeroes only the operator buffer", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    const keys: Buffer[] = [];
    const storeCopies: Buffer[] = [];
    state.dependencies.readRefKey = async () => { const key = Buffer.alloc(32, 0x51); keys.push(key); return key; };
    state.connectStore.mockImplementation(async (options) => {
      expect(options.migrationMode).toBe("verify");
      expect(options.tenantTelemetryRefKey instanceof Uint8Array).toBe(true);
      const bytes = options.tenantTelemetryRefKey!;
      expect(bytes.length).toBe(32);
      expect(bytes.every((byte) => byte === 0x51), "exact protected bytes must reach each store").toBe(true);
      storeCopies.push(Buffer.from(bytes));
      return state.store;
    });
    const env = { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/protected-ref-key" };
    await runBackupCatalogCli(["create-artifact"], artifactEnv(env), state.dependencies);
    state.connectStore.mockClear();
    await runBackupCatalogCli(["restore-selected"], artifactEnv({ ...env,
      RESTORE_RUN_ID, BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID,
      BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/keyed_target",
    }), state.dependencies);
    expect(state.connectStore).toHaveBeenCalledTimes(2);
    expect(artifacts.imported).toHaveBeenCalledOnce();
    expect(keys.every((key) => key.every((byte) => byte === 0)), "operator buffers are zeroed after closure").toBe(true);
    expect(storeCopies.every((key) => key.every((byte) => byte === 0x51)), "store-owned copies are not prematurely zeroed").toBe(true);
    storeCopies.forEach((key) => key.fill(0));
    expect(state.output.join("\n")).not.toContain("protected-ref-key");
  });

  it("bounds protected key acquisition with the artifact operation budget and zeroes a late reader result", async () => {
    const state = createHarness();
    const key = Buffer.alloc(32, 0x53);
    state.dependencies.readRefKey = () => new Promise((resolve) => { setTimeout(() => resolve(key), 30); });
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv({
      TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/bounded-ref-key", BACKUP_ARTIFACT_DEADLINE_MS: "10",
    }), state.dependencies)).rejects.toThrow("operation_deadline");
    expect(key.every((byte) => byte === 0), "late protected key must be zeroed").toBe(true);
    expect(state.connectStore).not.toHaveBeenCalled();
    expect(state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(state.output).toEqual([]);
  });

  it("formats only a known deadline code and never exposes arbitrary core error text", () => {
    expect(formatBackupCatalogCliError(new MySqlBackupArtifactError("operation_deadline")))
      .toBe('{"status":"error","code":"operation_deadline"}');
    expect(formatBackupCatalogCliError(new MySqlBackupArtifactError("private-key-DSN-marker")))
      .toBe('{"status":"error","code":"operation_failed"}');
  });
  it.each([
    { NODE_ENV: "production" }, { BACKUP_ARTIFACT_LOCAL_ONLY_ACK: "0" },
    { BACKUP_ARTIFACT_KEY_FILE: "relative-key" }, { BACKUP_ARTIFACT_DEADLINE_MS: "600001" },
    { BACKUP_ARTIFACT_MAX_BYTES: "1073741825" }, { BACKUP_MYSQL_BINARY: "mysql" },
    { RESTORE_FLEET_STOPPED_ACK: "0" },
  ])("rejects local authority before connecting or acquiring an operator: %j", async (extra) => {
    const state = createHarness();
    const artifacts = artifactHarness(state);
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv(extra), state.dependencies)).rejects.toThrow();
    expect(state.connectStore).not.toHaveBeenCalled();
    expect(state.loadCatalogConfig).not.toHaveBeenCalled();
    expect(artifacts.acquire).not.toHaveBeenCalled();
  });

  it("holds the operator from anchor through bytes authentication and publication", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    const anchor = vi.spyOn(state.store, "createTenantBackupSnapshotAnchor");
    const publish = vi.spyOn(state.catalogAdapter, "publishAvailability");
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    expect(artifacts.acquire.mock.invocationCallOrder[0]).toBeLessThan(anchor.mock.invocationCallOrder[0]!);
    expect(anchor.mock.invocationCallOrder[0]).toBeLessThan(artifacts.create.mock.invocationCallOrder[0]!);
    expect(artifacts.verify.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0]!);
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(artifacts.operator.close.mock.invocationCallOrder[0]!);
    expect(publish.mock.calls[0]![0]).toMatchObject(artifacts.evidence);
    const source = artifacts.create.mock.calls[0]![0].captureCheckpointStore;
    expect(source).not.toBe(state.store);
    expect(state.facadeUrls.get(source)).toBe(MYSQL_URL);
    expect(artifacts.operator.assertStoreBinding).toHaveBeenCalledWith(source, "source");
    expect(state.connectStore.mock.calls.at(-1)![0].tenantTelemetryCaptureRestoreLocalOnly).toBe(true);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({ command: "create-artifact", artifactVerified: true, ...artifacts.evidence });
    expect(state.output.join("\n")).not.toContain("/private/");
    expect(artifacts.verifiedClose).toHaveBeenCalledOnce();
  });

  it("rechecks a v2 source after bytes authentication and refuses external publication on drift", async () => {
    const state = createHarness(); await activateCatalog(state); const artifacts = artifactHarness(state);
    // Orchestration-only fixture: actual checkpoint/leaf authentication is covered
    // by the artifact pipeline and isolated MySQL tests, not this partial mock.
    const checkpointSha256 = sha256("actual-sealed-checkpoint");
    artifacts.verify.mockImplementationOnce(async (input) => ({
      manifest: { version: 2, anchor: input.expectedAnchor!, captureCheckpoint: { checkpointSha256 } } as never,
      evidence: artifacts.evidence, close: artifacts.verifiedClose,
    }));
    const unchanged = vi.spyOn(state.store, "assertTenantTelemetryCaptureBackupCheckpointUnchanged")
      .mockRejectedValueOnce(new Error("private-live-source-drift"));
    const publish = vi.spyOn(state.catalogAdapter, "publishAvailability");
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies)).rejects.toThrow();
    expect(unchanged).toHaveBeenCalledWith({ backupId: BACKUP_ID_1, checkpointSha256,
      fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" });
    expect(artifacts.verify.mock.invocationCallOrder[0]).toBeLessThan(unchanged.mock.invocationCallOrder[0]!);
    expect(publish).not.toHaveBeenCalled(); expect(artifacts.verifiedClose).toHaveBeenCalledOnce();
  });

  it.each([1, 2, 3])("replays already-published v%s exact evidence despite current source/catalog head drift", async (version) => {
    const state = createHarness(); await activateCatalog(state); const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    const publishedBefore = await state.catalogAdapter.inspectAvailability(BACKUP_ID_1);
    const headBefore = await state.catalogAdapter.readHead();
    expect(headBefore.catalogSequence).toBeGreaterThan(0);
    const manifest = (anchor: Parameters<typeof artifacts.create>[0]["anchor"]) => ({ version, anchor,
      schemaMigrationRootSha256: anchor.schemaMigrationRootSha256,
      ...(version !== 1 ? { captureCheckpoint: { checkpointSha256: sha256("historical-checkpoint") } } : {}),
    } as never);
    // The real producer independently authenticates actual historical SQL leaves;
    // these mocks isolate CLI's exact-replay publication ordering only.
    artifacts.create.mockImplementationOnce(async (input) => ({ disposition: "exact_replay", manifest: manifest(input.anchor), evidence: artifacts.evidence }));
    artifacts.verify.mockImplementationOnce(async (input) => ({ manifest: manifest(input.expectedAnchor!), evidence: artifacts.evidence, close: artifacts.verifiedClose }));
    const seal = vi.spyOn(state.store, "sealTenantTelemetryCaptureBackupCheckpoint").mockRejectedValue(new Error("current-head-advanced"));
    const unchanged = vi.spyOn(state.store, "assertTenantTelemetryCaptureBackupCheckpointUnchanged").mockRejectedValue(new Error("current-source-drift"));
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies)).resolves.toBe(0);
    expect(seal).not.toHaveBeenCalled(); expect(unchanged).not.toHaveBeenCalled();
    expect(await state.catalogAdapter.inspectAvailability(BACKUP_ID_1)).toEqual(publishedBefore);
    expect(await state.catalogAdapter.readHead()).toEqual(headBefore);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({ disposition: "exact_replay", artifactVerified: true, ...artifacts.evidence });
  });

  it("uses only the closed source-maintenance capability for protected artifact commands, without enabling normal capture writes", async () => {
    const state = createHarness(); await activateCatalog(state); const artifacts = artifactHarness(state);
    const rawKey = Buffer.alloc(32, 23); state.dependencies.readRefKey = async () => rawKey;
    await runBackupCatalogCli(["create-artifact"], artifactEnv({ TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/source-ref-key" }), state.dependencies);
    expect(state.connectCaptureBackupSourceMaintenance).toHaveBeenCalledOnce();
    const input = state.connectCaptureBackupSourceMaintenance.mock.calls[0]![0];
    expect(input).toMatchObject({ url: MYSQL_URL, fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" });
    expect(input).not.toHaveProperty("tenantTelemetryCaptureLocalOnly");
    expect(input).not.toHaveProperty("tenantTelemetryCaptureRestoreLocalOnly");
    const source = artifacts.create.mock.calls[0]![0].captureCheckpointStore;
    expect(source).not.toBe(state.store); expect(Object.isFrozen(source)).toBe(true);
    expect(source).not.toHaveProperty("createSession"); expect(source).not.toHaveProperty("claimTenantTelemetryWrites");
    expect(rawKey).toEqual(Buffer.alloc(32));
  });

  it("refuses a protected source missing its restricted factory before adapters, operator, seal or import, without ordinary fallback", async () => {
    const state = createHarness(); await activateCatalog(state); const artifacts = artifactHarness(state);
    const rawKey = Buffer.alloc(32, 24), readRefKey = vi.fn(async () => rawKey);
    state.dependencies.readRefKey = readRefKey;
    delete state.dependencies.connectCaptureBackupSourceMaintenance;
    state.connectStore.mockClear(); state.createCatalogAdapter.mockClear();
    const seal = vi.spyOn(state.store, "sealTenantTelemetryCaptureBackupCheckpoint");
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv({ TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/source-ref-key" }), state.dependencies))
      .rejects.toThrow("invalid_configuration");
    expect(state.connectStore).not.toHaveBeenCalled(); expect(state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(artifacts.acquire).not.toHaveBeenCalled(); expect(artifacts.create).not.toHaveBeenCalled();
    expect(artifacts.imported).not.toHaveBeenCalled(); expect(seal).not.toHaveBeenCalled();
    expect(readRefKey).not.toHaveBeenCalled();
    expect(rawKey).toEqual(Buffer.alloc(32, 24)); // New preflight never acquired this caller-owned key.
  });

  it.each([1, 2, 3] as const)("imports ASMYSQL%s after source prepare fences every source read/mirror, using only the complete fresh external chain", async (version) => {
    const h = await postPrepareFencedSourceHarness(version);
    const head = vi.spyOn(h.state.catalogAdapter, "readHead"), scan = vi.spyOn(h.state.catalogAdapter, "scanEvents");
    await expect(runBackupCatalogCli(["restore-selected"], h.restoreEnv(), h.state.dependencies)).resolves.toBe(0);
    expect(h.isFenced()).toBe(true); expect(h.useAfterFence).not.toHaveBeenCalled();
    expect(h.prepare).toHaveBeenCalledTimes(2); expect(h.artifacts.imported).toHaveBeenCalledOnce();
    const preparedOrder = h.prepare.mock.invocationCallOrder[0]!, importOrder = h.artifacts.imported.mock.invocationCallOrder[0]!;
    expect(head.mock.invocationCallOrder.filter((order) => order > preparedOrder && order < importOrder).length).toBe(2);
    expect(scan.mock.invocationCallOrder.filter((order) => order > preparedOrder && order < importOrder).length).toBeGreaterThan(0);
    expect(h.artifacts.operator.markRestorePrepared).toHaveBeenCalledOnce();
    if (version === 1) expect(h.connectMaintenance).not.toHaveBeenCalled();
    else expect(h.connectMaintenance).toHaveBeenCalledOnce();
    expect(JSON.parse(h.state.output.at(-1)!)).toMatchObject({ restorePhase: "prepared", runtimeActivated: false });
  });

  it("rejects a changed final authority head after fenced-source full-chain scan, before import", async () => {
    const h = await postPrepareFencedSourceHarness(3);
    // A genuine earlier fixture head, not an invented digest. Only adapter I/O
    // is stubbed to model a stale final observation; no SQL/S3 claim is made.
    const stale = await h.state.catalogDelegate.readHead();
    let postPrepareHeads = 0;
    vi.spyOn(h.state.catalogAdapter, "readHead").mockImplementation(async () => {
      if (h.isFenced() && ++postPrepareHeads === 2) return stale;
      return h.state.catalogDelegate.readHead();
    });
    const scan = vi.spyOn(h.state.catalogAdapter, "scanEvents");
    await expect(runBackupCatalogCli(["restore-selected"], h.restoreEnv(), h.state.dependencies)).rejects.toMatchObject({
      code: "catalog_conflict", restoreBoundary: { reservationMayBeConsumed: true, targetMayContainPartialImport: false },
    });
    expect(postPrepareHeads).toBe(2); expect(h.prepare).toHaveBeenCalledOnce();
    expect(scan.mock.invocationCallOrder.some((order) => order > h.prepare.mock.invocationCallOrder[0]!)).toBe(true);
    expect(h.useAfterFence).not.toHaveBeenCalled(); expect(h.artifacts.imported).not.toHaveBeenCalled();
    expect(h.connectMaintenance).not.toHaveBeenCalled(); expect(h.artifacts.operator.markRestorePrepared).not.toHaveBeenCalled();
  });

  it("rejects an exact external reservation that differs from the source prepare result, without consulting fenced source", async () => {
    // Deliberately corrupt only the returned orchestration response. The actual
    // Memory reservation/chain stay intact; this is NOT a valid DB receipt.
    const h = await postPrepareFencedSourceHarness(3, async (prepared) => ({ ...prepared, value: {
      ...prepared.value, reservation: { ...prepared.value.reservation,
        reservationReceiptSha256: sha256("different-prepare-response-reservation") },
    } }));
    await expect(runBackupCatalogCli(["restore-selected"], h.restoreEnv(), h.state.dependencies)).rejects.toMatchObject({
      code: "catalog_conflict", restoreBoundary: { reservationMayBeConsumed: true, targetMayContainPartialImport: false },
    });
    expect(h.prepare).toHaveBeenCalledOnce(); expect(h.useAfterFence).not.toHaveBeenCalled();
    expect(h.artifacts.imported).not.toHaveBeenCalled(); expect(h.connectMaintenance).not.toHaveBeenCalled();
    expect(h.artifacts.operator.markRestorePrepared).not.toHaveBeenCalled();
  });

  it("rejects a post-prepare evicted backup from its complete external chain even though historical availability remains", async () => {
    const h = await postPrepareFencedSourceHarness(3, async (prepared, state) => {
      const reservation = prepared.value.reservation;
      // Only the explicit non-production Memory adapter is advanced here. No
      // real restore activation, physical deletion or DB authority is forged.
      await state.catalogDelegate.resolveRestore({ restoreRunId: RESTORE_RUN_ID,
        reservationReceiptSha256: reservation.reservationReceiptSha256, phase: "activated" });
      const availability = await state.catalogDelegate.inspectAvailability(BACKUP_ID_1);
      if (!availability) throw new Error("fixture_availability_missing");
      const head = await state.catalogDelegate.readHead();
      const source = { evictionId: EVICTION_ID, backupId: BACKUP_ID_1, anchorSha256: availability.anchorSha256,
        entrySha256: availability.entrySha256, sourceSnapshotSha256: availability.sourceSnapshotSha256,
        sourceBackupSha256: availability.sourceBackupSha256, artifactManifestSha256: availability.artifactManifestSha256,
        providerEvidenceSha256: availability.providerEvidenceSha256, controlEvidenceSha256: availability.controlEvidenceSha256,
        retentionPolicySha256: availability.retentionPolicySha256, retentionUntilDbMs: availability.retentionUntilDbMs,
        expectedCatalogSequence: head.catalogSequence, expectedCatalogEventRootSha256: head.catalogEventRootSha256 };
      const operation = { ...source, evictionOperationSha256: tenantBackupEvictionOperationSha256(source) };
      await state.catalogDelegate.recordEviction({ plan: { ...operation, planSha256: tenantBackupEvictionPlanSha256(operation) },
        externalTombstoneSha256: sha256("fixture-only-post-prepare-eviction"), observedAbsent: true });
      return prepared;
    });
    await expect(runBackupCatalogCli(["restore-selected"], h.restoreEnv(), h.state.dependencies)).rejects.toMatchObject({
      code: "catalog_conflict", restoreBoundary: { reservationMayBeConsumed: true, targetMayContainPartialImport: false },
    });
    expect(await h.state.catalogDelegate.inspectAvailability(BACKUP_ID_1)).not.toBeNull();
    expect(h.prepare).toHaveBeenCalledOnce(); expect(h.useAfterFence).not.toHaveBeenCalled();
    expect(h.artifacts.imported).not.toHaveBeenCalled(); expect(h.connectMaintenance).not.toHaveBeenCalled();
  });

  it("does not import after another explicit operator resolved the newly reserved external run", async () => {
    const h = await postPrepareFencedSourceHarness(3, async (prepared, state) => {
      await state.catalogDelegate.resolveRestore({ restoreRunId: RESTORE_RUN_ID,
        reservationReceiptSha256: prepared.value.reservation.reservationReceiptSha256, phase: "activated" });
      return prepared;
    });
    await expect(runBackupCatalogCli(["restore-selected"], h.restoreEnv(), h.state.dependencies)).rejects.toMatchObject({
      code: "catalog_conflict", restoreBoundary: { reservationMayBeConsumed: true, targetMayContainPartialImport: false },
    });
    expect(h.prepare).toHaveBeenCalledOnce(); expect(h.useAfterFence).not.toHaveBeenCalled();
    expect(h.artifacts.imported).not.toHaveBeenCalled(); expect(h.connectMaintenance).not.toHaveBeenCalled();
  });

  it("passes authenticated ASMYSQL3 checkpoint identity through both actual-preflight boundaries and the cold exact-run selector (orchestration only)", async () => {
    const h = await v2MaintenanceHarness(3);
    await runBackupCatalogCli(["restore-selected"], h.restoreEnv(), h.state.dependencies);
    expect(h.preflight).toHaveBeenCalledTimes(2); expect(h.prepare).toHaveBeenCalledTimes(2);
    expect(h.reserve).toHaveBeenCalledTimes(2); expect(h.artifacts.imported).toHaveBeenCalledOnce();
    expect(h.connectMaintenance.mock.calls[0]![0].selector.checkpointSha256).toBe(h.checkpointSha256);
    expect(h.targetClose.mock.invocationCallOrder[0]).toBeLessThan(h.connectMaintenance.mock.invocationCallOrder[0]!);
    expect(JSON.parse(h.state.output.at(-1)!)).toMatchObject({ restorePhase: "prepared", runtimeActivated: false,
      fenceReplayComplete: false, requiresExplicitReplayAndActivation: true });
  });

  it("does not reserve or import after the actual operator rejects historical schema support before planned journal (orchestration only)", async () => {
    const h = await v2MaintenanceHarness(3);
    h.artifacts.operator.bindRestoreOperation.mockRejectedValueOnce(new MySqlBackupArtifactError("source_migration_mismatch"));
    await expect(runBackupCatalogCli(["restore-selected"], h.restoreEnv(), h.state.dependencies)).rejects.toThrow();
    expect(h.artifacts.operator.bindRestoreOperation).toHaveBeenCalledOnce();
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.preflight).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled();
    expect(h.artifacts.imported).not.toHaveBeenCalled(); expect(h.connectMaintenance).not.toHaveBeenCalled();
    expect(h.artifacts.operator.markRestorePrepared).not.toHaveBeenCalled();
    expect(h.artifacts.operator.close).toHaveBeenCalledOnce(); expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce();
  });

  it("does not make historical verify-artifact depend on the current mutable source checkpoint", async () => {
    const state = createHarness(); await activateCatalog(state); const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    const seal = vi.spyOn(state.store, "sealTenantTelemetryCaptureBackupCheckpoint").mockRejectedValue(new Error("source-now-changed"));
    const unchanged = vi.spyOn(state.store, "assertTenantTelemetryCaptureBackupCheckpointUnchanged").mockRejectedValue(new Error("source-now-changed"));
    await expect(runBackupCatalogCli(["verify-artifact"], artifactEnv(), state.dependencies)).resolves.toBe(0);
    expect(seal).not.toHaveBeenCalled(); expect(unchanged).not.toHaveBeenCalled();
    expect(artifacts.imported).not.toHaveBeenCalled();
  });

  it.each(["success", "cold_open_error"] as const)("binds authenticated v2 to reservation and cold target maintenance: %s", async (outcome) => {
    const { state, artifacts, checkpointSha256, preflight, prepare, reserve, maintenance, connectMaintenance,
      assertHeldResources, observed, restoreEnv, targetClose } = await v2MaintenanceHarness();
    if (outcome === "cold_open_error") connectMaintenance.mockImplementationOnce(async () => {
      assertHeldResources("factory"); throw new Error("private-cold-target-audit");
    });
    const invocation = runBackupCatalogCli(["restore-selected"], restoreEnv(), state.dependencies);
    if (outcome === "cold_open_error") {
      await expect(invocation).rejects.toMatchObject({ code: "operation_failed",
        restoreBoundary: { reservationMayBeConsumed: true, targetMayContainPartialImport: true } });
    } else await expect(invocation).resolves.toBe(0);
    expect(preflight).toHaveBeenCalledTimes(2); expect(prepare).toHaveBeenCalledTimes(2);
    expect(preflight.mock.invocationCallOrder[0]).toBeLessThan(reserve.mock.invocationCallOrder[0]!);
    expect(preflight.mock.invocationCallOrder[1]).toBeLessThan(reserve.mock.invocationCallOrder[1]!);
    expect(prepare.mock.invocationCallOrder[1]).toBeGreaterThan(artifacts.imported.mock.invocationCallOrder[0]!);
    expect(connectMaintenance).toHaveBeenCalledOnce();
    expect(connectMaintenance).toHaveBeenCalledWith({
      url: "mysql://fixture@127.0.0.1:3306/isolated_target", connectionLimit: 2,
      tenantTelemetryRefKey: expect.any(Buffer), operationAbortSignal: expect.any(AbortSignal),
      selector: { backupId: BACKUP_ID_1, restoreRunId: RESTORE_RUN_ID, checkpointSha256,
        artifactManifestSha256: artifacts.evidence.artifactManifestSha256,
        sourceSnapshotSha256: artifacts.evidence.sourceSnapshotSha256,
        providerEvidenceSha256: artifacts.evidence.providerEvidenceSha256,
        reservationSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        reservationReceiptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" },
    }, STOPPED_PROFILE);
    expect(connectMaintenance.mock.invocationCallOrder[0]).toBeGreaterThan(prepare.mock.invocationCallOrder[1]!);
    expect(targetClose.mock.invocationCallOrder[0]).toBeLessThan(connectMaintenance.mock.invocationCallOrder[0]!);
    if (outcome === "cold_open_error") {
      expect(maintenance.getTenantRestoreReplayRun).not.toHaveBeenCalled();
      expect(maintenance.close).not.toHaveBeenCalled();
      expect(artifacts.operator.markRestorePrepared).not.toHaveBeenCalled();
      expect(artifacts.imported).toHaveBeenCalledOnce();
      expect(artifacts.verifiedClose).toHaveBeenCalledOnce();
      expect(observed).toEqual(["factory"]);
      return;
    }
    expect(maintenance.getTenantRestoreReplayRun).toHaveBeenCalledWith(RESTORE_RUN_ID);
    expect(maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt).toHaveBeenCalledOnce();
    expect(maintenance.close).toHaveBeenCalledOnce();
    expect(observed).toEqual(["factory", "run", "history"]);
    expect(artifacts.operator.markRestorePrepared.mock.invocationCallOrder[0])
      .toBeGreaterThan(maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt.mock.invocationCallOrder[0]!);
  });

  it.each(["factory", "ref_key"] as const)("rejects selected v2 without %s before reservation or import", async (missing) => {
    const state = createHarness(); await activateCatalog(state); const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    artifacts.verify.mockImplementationOnce(async (input) => ({
      manifest: { version: 2, anchor: input.expectedAnchor!,
        captureCheckpoint: { checkpointSha256: sha256("selected-v2-checkpoint") } } as never,
      evidence: artifacts.evidence, close: artifacts.verifiedClose,
    }));
    state.dependencies.readRefKey = async () => Buffer.alloc(32, 17);
    state.dependencies.connectCaptureRestoreMaintenance = vi.fn(async () => { throw new Error("must not connect"); });
    if (missing === "factory") delete state.dependencies.connectCaptureRestoreMaintenance;
    const reserve = vi.spyOn(state.catalogAdapter, "reserveRestore");
    await expect(runBackupCatalogCli(["restore-selected"], artifactEnv({ RESTORE_RUN_ID,
      BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID,
      BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/isolated_target",
      ...(missing === "ref_key" ? {} : { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/fixture-ref-key" }),
    }), state.dependencies)).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(reserve).not.toHaveBeenCalled(); expect(artifacts.imported).not.toHaveBeenCalled();
    expect(artifacts.operator.markRestorePrepared).not.toHaveBeenCalled();
  });

  it("owns a late maintenance factory result and retains GCM/operator/key until its cleanup settles", async () => {
    const h = await v2MaintenanceHarness();
    let elapsed = 0;
    h.state.dependencies.now = () => elapsed;
    let resolveFactory: ((value: TenantTelemetryCaptureRestoreMaintenance) => void) | undefined;
    let entered!: () => void;
    const factoryEntered = new Promise<void>((resolve) => { entered = resolve; });
    h.connectMaintenance.mockImplementationOnce((options) => {
      h.assertHeldResources("factory");
      expect(options.operationAbortSignal?.aborted).toBe(false);
      entered();
      return new Promise<TenantTelemetryCaptureRestoreMaintenance>((resolve) => { resolveFactory = resolve; });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outputBefore = h.state.output.length;
      // Real artifactBudget code owns the timer/race. Only its clock/timer
      // transport is synthetic; no alternate timeout implementation is used.
      const invocation = runBackupCatalogCli(["restore-selected"], h.restoreEnv({ BACKUP_ARTIFACT_DEADLINE_MS: "1000" }), h.state.dependencies);
      const settled = invocation.then(() => ({ unexpectedSuccess: true }), (error: unknown) => ({ error }));
      await factoryEntered;
      expect(h.targetClose.mock.invocationCallOrder[0]).toBeLessThan(h.connectMaintenance.mock.invocationCallOrder[0]!);
      elapsed = 1_001;
      await vi.advanceTimersByTimeAsync(1_001);
      await vi.advanceTimersByTimeAsync(250); // Existing cleanup ceiling, not a widened operation budget.
      await expect(settled).resolves.toMatchObject({ error: { code: "operation_deadline",
        restoreBoundary: { reservationMayBeConsumed: true, targetMayContainPartialImport: true } } });
      expect(h.connectMaintenance.mock.calls[0]![0].operationAbortSignal?.aborted).toBe(true);
      expect(h.artifacts.imported).toHaveBeenCalledOnce(); expect(h.prepare).toHaveBeenCalledTimes(2);
      expect(h.maintenance.close).not.toHaveBeenCalled();
      expect(h.maintenance.getTenantRestoreReplayRun).not.toHaveBeenCalled();
      expect(h.artifacts.operator.close).not.toHaveBeenCalled(); expect(h.artifacts.verifiedClose).not.toHaveBeenCalled();
      expect(h.refKey.every((byte) => byte === 17), "pending factory must retain its operator key").toBe(true);
      expect(h.state.output).toHaveLength(outputBefore); expect(h.artifacts.operator.markRestorePrepared).not.toHaveBeenCalled();
      resolveFactory!(h.maintenance);
      await vi.waitFor(() => {
        expect(h.maintenance.close).toHaveBeenCalledOnce(); expect(h.artifacts.operator.close).toHaveBeenCalledOnce();
        expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce(); expect(h.refKey.every((byte) => byte === 0)).toBe(true);
      });
      expect(h.maintenance.close.mock.invocationCallOrder[0]).toBeLessThan(h.artifacts.operator.close.mock.invocationCallOrder[0]!);
      expect(h.maintenance.close.mock.invocationCallOrder[0]).toBeLessThan(h.artifacts.verifiedClose.mock.invocationCallOrder[0]!);
      expect(h.maintenance.getTenantRestoreReplayRun).not.toHaveBeenCalled();
      expect(h.artifacts.operator.markRestorePrepared).not.toHaveBeenCalled(); expect(h.state.output).toHaveLength(outputBefore);
    } finally {
      resolveFactory?.(h.maintenance);
      await vi.runAllTimersAsync(); vi.useRealTimers();
    }
  });

  it("aborts a hung maintenance history getter without releasing held resources or continuing when it later resolves", async () => {
    const h = await v2MaintenanceHarness();
    let elapsed = 0;
    h.state.dependencies.now = () => elapsed;
    let resolveRead: ((value: null) => void) | undefined;
    let entered!: () => void;
    const historyEntered = new Promise<void>((resolve) => { entered = resolve; });
    h.maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt.mockImplementationOnce(() => {
      h.assertHeldResources("history"); entered();
      return new Promise<null>((resolve) => { resolveRead = resolve; });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outputBefore = h.state.output.length;
      const invocation = runBackupCatalogCli(["restore-selected"], h.restoreEnv({ BACKUP_ARTIFACT_DEADLINE_MS: "1000" }), h.state.dependencies);
      const settled = invocation.then(() => ({ unexpectedSuccess: true }), (error: unknown) => ({ error }));
      await historyEntered;
      expect(h.observed).toEqual(["factory", "run", "history"]);
      elapsed = 1_001;
      await vi.advanceTimersByTimeAsync(1_001);
      await vi.advanceTimersByTimeAsync(250);
      await expect(settled).resolves.toMatchObject({ error: { code: "operation_deadline",
        restoreBoundary: { reservationMayBeConsumed: true, targetMayContainPartialImport: true } } });
      expect(h.connectMaintenance.mock.calls[0]![0].operationAbortSignal?.aborted).toBe(true);
      // The native facade is asked to cancel/close, but this deliberately
      // uncooperative getter still owns the lock/FD until its promise settles.
      expect(h.maintenance.close).toHaveBeenCalledOnce();
      expect(h.artifacts.operator.close).not.toHaveBeenCalled(); expect(h.artifacts.verifiedClose).not.toHaveBeenCalled();
      expect(h.refKey.every((byte) => byte === 17), "pending getter must retain its operator key").toBe(true);
      expect(h.artifacts.operator.markRestorePrepared).not.toHaveBeenCalled(); expect(h.state.output).toHaveLength(outputBefore);
      resolveRead!(null);
      await vi.waitFor(() => {
        expect(h.artifacts.operator.close).toHaveBeenCalledOnce(); expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce();
        expect(h.refKey.every((byte) => byte === 0)).toBe(true);
      });
      expect(h.maintenance.close).toHaveBeenCalledOnce(); expect(h.maintenance.getTenantRestoreReplayRun).toHaveBeenCalledOnce();
      expect(h.maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt).toHaveBeenCalledOnce();
      expect(h.artifacts.imported).toHaveBeenCalledOnce(); expect(h.artifacts.operator.markRestorePrepared).not.toHaveBeenCalled();
      expect(h.state.output).toHaveLength(outputBefore);
    } finally {
      resolveRead?.(null);
      await vi.runAllTimersAsync(); vi.useRealTimers();
    }
  });

  it("accepts first-import native closes fulfilled during the existing drain window after the first cleanup wait", async () => {
    const h = await v2MaintenanceHarness();
    let resolveClose: (() => void) | undefined;
    let entered!: () => void; const closeStarted = new Promise<void>((resolve) => { entered = resolve; });
    const closeFulfilled = vi.fn(() => {});
    h.maintenance.close.mockImplementationOnce(async () => {
      entered(); await new Promise<void>((resolve) => { resolveClose = resolve; }); closeFulfilled();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outputBefore = h.state.output.length;
      let invocationSettled = false;
      const result = runBackupCatalogCli(["restore-selected"], h.restoreEnv(), h.state.dependencies).then(
        (status) => { invocationSettled = true; return { status }; },
        (error: unknown) => { invocationSettled = true; return { error }; },
      );
      await closeStarted; await vi.advanceTimersByTimeAsync(250);
      expect(invocationSettled).toBe(false);
      expect(h.artifacts.operator.close).not.toHaveBeenCalled(); expect(h.artifacts.verifiedClose).not.toHaveBeenCalled();
      expect(h.refKey.every((byte) => byte === 17)).toBe(true);
      expect(h.state.output).toHaveLength(outputBefore); expect(closeFulfilled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50); resolveClose!();
      await expect(result).resolves.toEqual({ status: 0 });
      expect(h.maintenance.close).toHaveBeenCalledOnce(); expect(closeFulfilled).toHaveBeenCalledOnce();
      expect(h.artifacts.operator.close).toHaveBeenCalledOnce(); expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce();
      expect(closeFulfilled.mock.invocationCallOrder[0]).toBeLessThan(h.artifacts.operator.close.mock.invocationCallOrder[0]!);
      expect(closeFulfilled.mock.invocationCallOrder[0]).toBeLessThan(h.artifacts.verifiedClose.mock.invocationCallOrder[0]!);
      expect(h.refKey.every((byte) => byte === 0)).toBe(true);
      expect(h.state.output).toHaveLength(outputBefore + 1);
      expect(JSON.parse(h.state.output.at(-1)!)).toMatchObject({ status: "ok", command: "restore-selected",
        restorePhase: "prepared", runtimeActivated: false, fenceReplayComplete: false, requiresExplicitReplayAndActivation: true });
      expect(h.preflight).toHaveBeenCalledTimes(2); expect(h.prepare).toHaveBeenCalledTimes(2);
      expect(h.reserve).toHaveBeenCalledTimes(2); expect(h.artifacts.imported).toHaveBeenCalledOnce();
      expect(h.targetClose).toHaveBeenCalledOnce(); expect(h.state.storeClose).toHaveBeenCalledOnce();
    } finally { resolveClose?.(); await vi.runAllTimersAsync(); vi.useRealTimers(); }
  });

  it("keeps a first-import native close rejection as failure when the remaining close fulfills during the drain window", async () => {
    const h = await v2MaintenanceHarness();
    h.state.storeClose.mockRejectedValueOnce(new Error("private native close rejection"));
    let resolveClose: (() => void) | undefined;
    let entered!: () => void; const closeStarted = new Promise<void>((resolve) => { entered = resolve; });
    const closeFulfilled = vi.fn(() => {});
    h.maintenance.close.mockImplementationOnce(async () => {
      entered(); await new Promise<void>((resolve) => { resolveClose = resolve; }); closeFulfilled();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outputBefore = h.state.output.length;
      let invocationSettled = false;
      const result = runBackupCatalogCli(["restore-selected"], h.restoreEnv(), h.state.dependencies).then(
        (status) => { invocationSettled = true; return { status }; },
        (error: unknown) => { invocationSettled = true; return { error }; },
      );
      await closeStarted; await vi.advanceTimersByTimeAsync(250);
      expect(invocationSettled).toBe(false);
      expect(h.artifacts.operator.close).not.toHaveBeenCalled(); expect(h.artifacts.verifiedClose).not.toHaveBeenCalled();
      expect(h.refKey.every((byte) => byte === 17)).toBe(true);
      expect(h.state.output).toHaveLength(outputBefore); expect(closeFulfilled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50); resolveClose!();
      await expect(result).resolves.toMatchObject({ error: { code: "operation_failed",
        restoreBoundary: { reservationMayBeConsumed: true, targetMayContainPartialImport: true } } });
      expect(h.state.storeClose).toHaveBeenCalledOnce(); expect(h.maintenance.close).toHaveBeenCalledOnce();
      expect(closeFulfilled).toHaveBeenCalledOnce();
      expect(h.artifacts.operator.close).toHaveBeenCalledOnce(); expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce();
      expect(closeFulfilled.mock.invocationCallOrder[0]).toBeLessThan(h.artifacts.operator.close.mock.invocationCallOrder[0]!);
      expect(closeFulfilled.mock.invocationCallOrder[0]).toBeLessThan(h.artifacts.verifiedClose.mock.invocationCallOrder[0]!);
      expect(h.refKey.every((byte) => byte === 0)).toBe(true); expect(h.state.output).toHaveLength(outputBefore);
    } finally { resolveClose?.(); await vi.runAllTimersAsync(); vi.useRealTimers(); }
  });

  it("keeps the operator and key held when maintenance close itself exceeds the foreground cleanup ceiling", async () => {
    const h = await v2MaintenanceHarness();
    let resolveClose: (() => void) | undefined;
    let closeEntered!: () => void;
    const closeStarted = new Promise<void>((resolve) => { closeEntered = resolve; });
    h.maintenance.close.mockImplementationOnce(() => {
      closeEntered();
      return new Promise<void>((resolve) => { resolveClose = resolve; });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outputBefore = h.state.output.length;
      const invocation = runBackupCatalogCli(["restore-selected"], h.restoreEnv(), h.state.dependencies);
      const settled = invocation.then(() => ({ unexpectedSuccess: true }), (error: unknown) => ({ error }));
      await closeStarted;
      await vi.advanceTimersByTimeAsync(500);
      await expect(settled).resolves.toMatchObject({ error: { code: "operation_failed" } });
      expect(h.artifacts.operator.close).not.toHaveBeenCalled();
      expect(h.artifacts.verifiedClose).not.toHaveBeenCalled();
      expect(h.refKey.every((byte) => byte === 17)).toBe(true);
      expect(h.state.output).toHaveLength(outputBefore);
      resolveClose!();
      await vi.waitFor(() => {
        expect(h.artifacts.operator.close).toHaveBeenCalledOnce();
        expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce();
        expect(h.refKey.every((byte) => byte === 0)).toBe(true);
      });
    } finally {
      resolveClose?.();
      await vi.runAllTimersAsync(); vi.useRealTimers();
    }
  });

  it("waits for every native close even when one rejects before a maintenance close settles", async () => {
    const h = await v2MaintenanceHarness();
    let resolveClose: (() => void) | undefined;
    let closeEntered!: () => void;
    const closeStarted = new Promise<void>((resolve) => { closeEntered = resolve; });
    h.maintenance.close.mockImplementationOnce(() => {
      closeEntered();
      return new Promise<void>((resolve) => { resolveClose = resolve; });
    });
    h.state.storeClose.mockRejectedValueOnce(new Error("private native close rejection"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outputBefore = h.state.output.length;
      const invocation = runBackupCatalogCli(["restore-selected"], h.restoreEnv(), h.state.dependencies);
      const settled = invocation.then(() => ({ unexpectedSuccess: true }), (error: unknown) => ({ error }));
      await closeStarted;
      await vi.advanceTimersByTimeAsync(500);
      await expect(settled).resolves.toMatchObject({ error: { code: "operation_failed" } });
      expect(h.state.storeClose).toHaveBeenCalledOnce();
      expect(h.artifacts.operator.close).not.toHaveBeenCalled();
      expect(h.artifacts.verifiedClose).not.toHaveBeenCalled();
      expect(h.refKey.every((byte) => byte === 17)).toBe(true);
      expect(h.state.output).toHaveLength(outputBefore);
      resolveClose!();
      await vi.waitFor(() => {
        expect(h.artifacts.operator.close).toHaveBeenCalledOnce();
        expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce();
        expect(h.refKey.every((byte) => byte === 0)).toBe(true);
      });
    } finally {
      resolveClose?.();
      await vi.runAllTimersAsync(); vi.useRealTimers();
    }
  });

  it("tracks an after-result deadline disposal until its maintenance close settles", async () => {
    const h = await v2MaintenanceHarness();
    let elapsed = 0;
    h.state.dependencies.now = () => elapsed;
    let resolveClose: (() => void) | undefined;
    let closeEntered!: () => void;
    const closeStarted = new Promise<void>((resolve) => { closeEntered = resolve; });
    h.maintenance.close.mockImplementationOnce(() => {
      closeEntered();
      return new Promise<void>((resolve) => { resolveClose = resolve; });
    });
    h.connectMaintenance.mockImplementationOnce(async (options) => {
      h.assertHeldResources("factory");
      expect(options.operationAbortSignal?.aborted).toBe(false);
      elapsed = 1_001;
      return h.maintenance;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outputBefore = h.state.output.length;
      const invocation = runBackupCatalogCli(["restore-selected"], h.restoreEnv({
        BACKUP_ARTIFACT_DEADLINE_MS: "1000",
      }), h.state.dependencies);
      const settled = invocation.then(() => ({ unexpectedSuccess: true }), (error: unknown) => ({ error }));
      await closeStarted;
      await vi.advanceTimersByTimeAsync(500);
      await expect(settled).resolves.toMatchObject({ error: { code: "operation_deadline" } });
      expect(h.maintenance.close).toHaveBeenCalledOnce();
      expect(h.artifacts.operator.close).not.toHaveBeenCalled();
      expect(h.artifacts.verifiedClose).not.toHaveBeenCalled();
      expect(h.refKey.every((byte) => byte === 17)).toBe(true);
      expect(h.state.output).toHaveLength(outputBefore);
      resolveClose!();
      await vi.waitFor(() => {
        expect(h.artifacts.operator.close).toHaveBeenCalledOnce();
        expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce();
        expect(h.refKey.every((byte) => byte === 0)).toBe(true);
      });
    } finally {
      resolveClose?.();
      await vi.runAllTimersAsync(); vi.useRealTimers();
    }
  });

  it("does not zero the protected key while operator release itself remains pending", async () => {
    const h = await v2MaintenanceHarness();
    let resolveRelease: (() => void) | undefined;
    let releaseEntered!: () => void;
    const releaseStarted = new Promise<void>((resolve) => { releaseEntered = resolve; });
    h.artifacts.operator.close.mockImplementationOnce(() => {
      releaseEntered();
      return new Promise<void>((resolve) => { resolveRelease = resolve; });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outputBefore = h.state.output.length;
      const invocation = runBackupCatalogCli(["restore-selected"], h.restoreEnv(), h.state.dependencies);
      const settled = invocation.then(() => ({ unexpectedSuccess: true }), (error: unknown) => ({ error }));
      await releaseStarted;
      await vi.advanceTimersByTimeAsync(250);
      await expect(settled).resolves.toMatchObject({ error: { code: "operation_failed" } });
      expect(h.maintenance.close).toHaveBeenCalledOnce();
      expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce();
      expect(h.refKey.every((byte) => byte === 17)).toBe(true);
      expect(h.state.output).toHaveLength(outputBefore);
      resolveRelease!();
      await vi.waitFor(() => expect(h.refKey.every((byte) => byte === 0)).toBe(true));
    } finally {
      resolveRelease?.();
      await vi.runAllTimersAsync(); vi.useRealTimers();
    }
  });

  it("does not infer selected-v1 authority from an unrelated existing checkpoint before reserve/import", async () => {
    const state = createHarness(); await activateCatalog(state); const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    const historical = vi.spyOn(state.store, "getTenantTelemetryCaptureBackupCheckpoint").mockResolvedValue({
      checkpoint: { checkpointSha256: sha256("unselected-live-checkpoint") }, leaves: [],
    } as never);
    const preflight = vi.spyOn(state.store, "preflightTenantRestoreReplayFromBackup").mockImplementation(async (input) => {
      expect(input.captureCheckpointSha256).toBeUndefined(); throw new Error("active-source-requires-selected-v2-checkpoint");
    });
    const reserve = vi.spyOn(state.catalogAdapter, "reserveRestore");
    await expect(runBackupCatalogCli(["restore-selected"], artifactEnv({ RESTORE_RUN_ID,
      BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID, BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/isolated_target" }), state.dependencies)).rejects.toThrow();
    expect(preflight).toHaveBeenCalledOnce(); expect(historical).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled(); expect(artifacts.imported).not.toHaveBeenCalled();
  });

  it("closes a constructed catalog client when the later journal factory fails", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    state.createJournalAdapters.mockImplementationOnce(() => { throw new Error("private-factory-config"); });
    state.connectStore.mockClear();
    const outputCount = state.output.length;
    await expect(runBackupCatalogCli(["restore-selected"], artifactEnv({
      RESTORE_RUN_ID, BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID,
      BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/isolated_target",
    }), state.dependencies)).rejects.toThrow();
    expect(state.catalogAdapter.close).toHaveBeenCalledTimes(2);
    expect(state.connectStore).not.toHaveBeenCalled();
    expect(artifacts.acquire).not.toHaveBeenCalled();
    expect(state.output).toHaveLength(outputCount);
  });

  it("requires fresh availability before authenticating bytes", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    artifacts.verify.mockClear();
    state.catalogAdapter.inspectAvailability = vi.fn(async () => null);
    await expect(runBackupCatalogCli(["verify-artifact"], artifactEnv(), state.dependencies)).rejects.toThrow("catalog_conflict");
    expect(artifacts.verify).not.toHaveBeenCalled();
  });

  it("refuses an actual sealed eviction even though inspectAvailability retains its historical entry", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    await createAndPublish(state, BACKUP_ID_2, "second-backup");
    state.clock.value += 100;
    const eviction = catalogEnv({ BACKUP_ID: BACKUP_ID_1, BACKUP_EVICTION_ID: EVICTION_ID,
      RESTORE_FLEET_STOPPED_ACK: "1", BACKUP_PHYSICAL_ABSENCE_ACK: "1",
      EXTERNAL_TOMBSTONE_SHA256: sha256("physical-absence") });
    await runBackupCatalogCli(["prepare-eviction"], eviction, state.dependencies);
    await runBackupCatalogCli(["record-eviction"], eviction, state.dependencies);
    expect(await state.catalogAdapter.inspectAvailability(BACKUP_ID_1)).not.toBeNull();
    artifacts.verify.mockClear();
    await expect(runBackupCatalogCli(["verify-artifact"], artifactEnv(), state.dependencies)).rejects.toThrow("catalog_conflict");
    expect(artifacts.verify).not.toHaveBeenCalled();
  });

  it("does not publish after whole-operation deadline expires in the producer", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    let elapsed = 0;
    state.dependencies.now = () => elapsed;
    artifacts.create.mockImplementationOnce(async (input) => {
      elapsed = 11;
      return { disposition: "created", manifest: { anchor: input.anchor } as Awaited<ReturnType<NonNullable<BackupCatalogCliDependencies["artifactOperations"]>["createMySqlBackupArtifact"]>>["manifest"], evidence: artifacts.evidence };
    });
    const publish = vi.spyOn(state.catalogAdapter, "publishAvailability");
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv({ BACKUP_ARTIFACT_DEADLINE_MS: "10" }), state.dependencies)).rejects.toThrow("operation_deadline");
    expect(publish).not.toHaveBeenCalled();
    expect(artifacts.verify).not.toHaveBeenCalled();
    expect(artifacts.operator.close).toHaveBeenCalledOnce();
  });

  it("closes an operator acquired exactly as the deadline expires before connecting or writing an anchor", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    let elapsed = 0;
    state.dependencies.now = () => elapsed;
    state.connectStore.mockClear();
    artifacts.acquire.mockImplementationOnce(async () => { elapsed = 11; return artifacts.operator; });
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv({ BACKUP_ARTIFACT_DEADLINE_MS: "10" }), state.dependencies)).rejects.toThrow("operation_deadline");
    expect(artifacts.operator.close).toHaveBeenCalledOnce();
    expect(state.connectStore).not.toHaveBeenCalled();
    expect(artifacts.create).not.toHaveBeenCalled();
  });

  it("bounds an uncompleted adapter startup by actual wall time and starts no authority", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    state.connectStore.mockClear();
    state.catalogAdapter.validateStartup = vi.fn(() => new Promise<void>(() => {}));
    const started = performance.now();
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv({
      BACKUP_ARTIFACT_DEADLINE_MS: "1000",
    }), state.dependencies)).rejects.toThrow("operation_deadline");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(state.catalogAdapter.validateStartup).toHaveBeenCalledOnce();
    expect(artifacts.acquire).not.toHaveBeenCalled();
    expect(state.connectStore).not.toHaveBeenCalled();
  });

  it("disposes a late store without releasing the operator lock while work is pending", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    let resolveStore!: (value: typeof state.store) => void;
    state.connectStore.mockClear();
    state.connectStore.mockImplementationOnce(() => new Promise((resolve) => { resolveStore = resolve; }));
    const anchor = vi.spyOn(state.store, "createTenantBackupSnapshotAnchor");
    const started = performance.now();
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv({
      BACKUP_ARTIFACT_DEADLINE_MS: "1000",
    }), state.dependencies)).rejects.toThrow("operation_deadline");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(state.connectStore).toHaveBeenCalledOnce();
    expect(artifacts.operator.close).not.toHaveBeenCalled();
    expect(state.connectStore.mock.calls.at(-1)![0]).toMatchObject({ operationAbortSignal: expect.any(AbortSignal) });
    expect(state.connectStore.mock.calls.at(-1)![0].operationAbortSignal!.aborted).toBe(true);
    resolveStore(state.store);
    await vi.waitFor(() => expect(artifacts.operator.close).toHaveBeenCalledOnce());
    expect(anchor).not.toHaveBeenCalled();
    expect(artifacts.create).not.toHaveBeenCalled();
  });

  it("bounds a never-resolving reservation and never imports after its deadline", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    state.catalogAdapter.reserveRestore = vi.fn(() => new Promise<never>(() => {}));
    const started = performance.now();
    let failure: unknown;
    try {
      await runBackupCatalogCli(["restore-selected"], artifactEnv({
        RESTORE_RUN_ID, BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID,
        BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/isolated_target",
        BACKUP_ARTIFACT_DEADLINE_MS: "1000",
      }), state.dependencies);
    } catch (error) { failure = error; }
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(state.catalogAdapter.reserveRestore).toHaveBeenCalledOnce();
    expect(JSON.parse(formatBackupCatalogCliError(failure))).toMatchObject({
      code: "operation_deadline", reservationMayBeConsumed: true,
      targetMayContainPartialImport: false, requiresManualForwardFix: true,
    });
    expect(artifacts.imported).not.toHaveBeenCalled();
    expect(artifacts.operator.markRestorePrepared).not.toHaveBeenCalled();
    // Only create's prior operator has closed; pending custom work retains the restore lock.
    expect(artifacts.operator.close).toHaveBeenCalledTimes(1);
  });

  it.each(["readHead", "scanEvents", "mirror", "publishAvailability"] as const)(
    "bounds an uncompleted %s stage and never writes subsequent availability", async (stage) => {
      const state = createHarness();
      await activateCatalog(state);
      const artifacts = artifactHarness(state);
      await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
      const record = vi.spyOn(state.store, "recordTenantBackupCatalogAvailability");
      const hung = vi.fn(() => new Promise<never>(() => {}));
      if (stage === "readHead") state.catalogAdapter.readHead = hung;
      else if (stage === "scanEvents") state.catalogAdapter.scanEvents = hung;
      else if (stage === "mirror") vi.spyOn(state.store, "mirrorTenantBackupCatalogEvent")
        .mockImplementation(hung);
      else state.catalogAdapter.publishAvailability = hung;
      const outputCount = state.output.length;
      const started = performance.now();
      await expect(runBackupCatalogCli(["create-artifact"], artifactEnv({
        BACKUP_ID: BACKUP_ID_2, BACKUP_ARTIFACT_DEADLINE_MS: "1000",
      }), state.dependencies)).rejects.toThrow("operation_deadline");
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(hung).toHaveBeenCalledOnce();
      expect(state.output).toHaveLength(outputCount);
      expect(record).not.toHaveBeenCalled();
    },
  );

  it("does not report success or record a published availability after the source lock is lost", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    let lost = false;
    artifacts.operator.assertHeld.mockImplementation(async () => { if (lost) throw new Error("private-lock-loss"); });
    const publish = state.catalogAdapter.publishAvailability;
    state.catalogAdapter.publishAvailability = async (input) => {
      const result = await publish(input);
      lost = true;
      return result;
    };
    const record = vi.spyOn(state.store, "recordTenantBackupCatalogAvailability");
    const outputCount = state.output.length;
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies)).rejects.toThrow();
    expect(await state.catalogDelegate.inspectAvailability(BACKUP_ID_1)).not.toBeNull();
    expect(record).not.toHaveBeenCalled();
    expect(state.output).toHaveLength(outputCount);
  });

  it.each(["run", "epoch"] as const)("rejects a previous permanent %s reservation even with another directory and target", async (reuse) => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    expect(Object.isFrozen(artifacts.operator)).toBe(true);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    const entry = await state.catalogAdapter.inspectAvailability(BACKUP_ID_1);
    await state.catalogAdapter.reserveRestore({ backupId: BACKUP_ID_1, entrySha256: entry!.entrySha256,
      restoreRunId: RESTORE_RUN_ID, runtimeEpochSha256: tenantRestoreRuntimeEpochSha256(RESTORE_EPOCH_ID) });
    await expect(runBackupCatalogCli(["restore-selected"], artifactEnv({
      BACKUP_ARTIFACT_DIRECTORY: "/private/another-fixture-artifacts",
      RESTORE_RUN_ID: reuse === "run" ? RESTORE_RUN_ID : "restore_00000000-0000-4000-8000-000000000002",
      BACKUP_RUNTIME_EPOCH_ID: reuse === "epoch" ? RESTORE_EPOCH_ID : "different-never-used-epoch",
      BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/second_empty_target",
    }), state.dependencies)).rejects.toThrow("catalog_conflict");
    expect(artifacts.operator.assertHeld).toHaveBeenCalled();
    expect(artifacts.operator.bindRestoreOperation).not.toHaveBeenCalled();
    expect(artifacts.imported).not.toHaveBeenCalled();
  });

  it("reserves on source, imports held authentication and verifies the target before exact reprepare", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    const prepared = vi.spyOn(state.store, "prepareTenantRestoreReplayFromBackup");
    state.connectStore.mockClear();
    await runBackupCatalogCli(["restore-selected"], artifactEnv({
      RESTORE_RUN_ID, BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID,
      BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/isolated_target",
    }), state.dependencies);
    expect(prepared).toHaveBeenCalledTimes(2);
    expect(artifacts.operator.bindRestoreOperation.mock.invocationCallOrder[0]).toBeLessThan(prepared.mock.invocationCallOrder[0]!);
    expect(prepared.mock.invocationCallOrder[0]).toBeLessThan(artifacts.imported.mock.invocationCallOrder[0]!);
    expect(artifacts.imported.mock.invocationCallOrder[0]).toBeLessThan(state.connectStore.mock.invocationCallOrder[1]!);
    expect(state.connectStore.mock.calls[1]![0]).toMatchObject({ migrationMode: "verify", url: "mysql://fixture@127.0.0.1:3306/isolated_target" });
    expect(state.connectStore.mock.calls.map(([options]) => options.tenantTelemetryCaptureRestoreLocalOnly)).toEqual([true, true]);
    expect(prepared.mock.invocationCallOrder[1]).toBeLessThan(artifacts.operator.markRestorePrepared.mock.invocationCallOrder[0]!);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({ command: "restore-selected", restorePhase: "prepared", runtimeActivated: false, fenceReplayComplete: false });
  });

  it("preserves reservation and closes held resources when post-import target verification fails", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    state.connectStore.mockImplementation(async (input?: { url: string }) => {
      if (input?.url.includes("isolated_target")) throw new Error("private-target-DSN-and-key-marker");
      return state.store;
    });
    const outputCount = state.output.length;
    let failure: unknown;
    try {
      await runBackupCatalogCli(["restore-selected"], artifactEnv({
        RESTORE_RUN_ID, BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID,
        BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/isolated_target",
      }), state.dependencies);
    } catch (error) { failure = error; }
    expect(JSON.parse(formatBackupCatalogCliError(failure))).toEqual({
      status: "error", code: "operation_failed", reservationMayBeConsumed: true,
      targetMayContainPartialImport: true, requiresManualForwardFix: true, runtimeActivated: false,
    });
    expect(state.output).toHaveLength(outputCount);
    expect(artifacts.imported).toHaveBeenCalledOnce();
    expect(artifacts.operator.markRestorePrepared).not.toHaveBeenCalled();
    expect(await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID)).toMatchObject({ phase: "reserved" });
    expect(artifacts.operator.close).toHaveBeenCalledTimes(2);
    expect(artifacts.verifiedClose).toHaveBeenCalledTimes(2);
  });
});

describe("backup catalog CLI", () => {
  it("keeps inactive keyless status compatible and accepts a protected key without constructing S3", async () => {
    const state = createHarness();
    await runBackupCatalogCli(["status"], baseEnv(), state.dependencies);
    expect(state.connectStore.mock.calls.at(-1)![0].tenantTelemetryRefKey).toBeUndefined();
    expect(state.connectStore.mock.calls.at(-1)![0].tenantTelemetryCaptureRestoreLocalOnly).toBeUndefined();
    const key = Buffer.alloc(32, 0x29);
    state.dependencies.readRefKey = async () => key;
    state.connectStore.mockImplementation(async (input) => {
      expect(input.tenantTelemetryRefKey instanceof Uint8Array).toBe(true);
      expect(input.tenantTelemetryRefKey!.every((byte) => byte === 0x29), "exact key required").toBe(true);
      return state.store;
    });
    await runBackupCatalogCli(["status"], baseEnv({ TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/ref-key" }), state.dependencies);
    expect(key.every((byte) => byte === 0), "operator buffer must be zeroed").toBe(true);
    expect(state.createCatalogAdapter).not.toHaveBeenCalled();
  });

  it.each([{ TENANT_TELEMETRY_REF_KEY: "" }, { TENANT_TELEMETRY_REF_KEY: "private-key" },
    { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "" }, { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "relative" }])(
    "rejects ambient hex and invalid operator key authority before external resources %#", async (extra) => {
      const state = createHarness();
      const failure = await runBackupCatalogCli(["status"], baseEnv(extra), state.dependencies).catch((error: unknown) => error);
      expect(formatBackupCatalogCliError(failure)).toBe('{"status":"error","code":"invalid_configuration"}');
      expect(state.connectStore).not.toHaveBeenCalled();
      expect(state.createCatalogAdapter).not.toHaveBeenCalled();
    });

  it("zeros the protected buffer when strict startup rejects and never emits success", async () => {
    const state = createHarness();
    const key = Buffer.alloc(32, 0x37);
    state.dependencies.readRefKey = async () => key;
    state.connectStore.mockImplementation(async () => { throw new Error("private-audit-details"); });
    const failure = await runBackupCatalogCli(["status"], baseEnv({ TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/ref-key" }), state.dependencies)
      .catch((error: unknown) => error);
    expect(formatBackupCatalogCliError(failure)).toBe('{"status":"error","code":"operation_failed"}');
    expect(key.every((byte) => byte === 0), "rejected startup must zero the operator buffer").toBe(true);
    expect(state.output).toEqual([]);
  });

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
      schemaMetadata: SCHEMA_METADATA,
    });
    expect(state.connectStore).toHaveBeenNthCalledWith(2, {
      url: MYSQL_URL,
      connectionLimit: 1,
      migrationMode: "verify",
      schemaMetadata: SCHEMA_METADATA,
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


describe("explicit authority profiles in backup CLI orchestration doubles", () => {
  it("rejects ambient authority in ordinary and artifact commands before resources, including an unread accessor", async () => {
    for (const command of ["status", "list", "create-artifact", "verify-artifact", "restore-selected"] as const) {
      const state = createHarness(), artifacts = artifactHarness(state), readRefKey = vi.fn(async () => Buffer.alloc(32));
      state.dependencies.readRefKey = readRefKey;
      let reads = 0;
      const env = artifactEnv({ TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/unopened-ref-key" });
      Object.defineProperty(env, "AUTHORITY_MYSQL_URL", { enumerable: false, get() { reads++; throw new Error(RESPONSE_LOSS_MARKER); } });
      const failure = await runBackupCatalogCli([command], env, state.dependencies).catch((error: unknown) => error);
      expect(formatBackupCatalogCliError(failure)).toBe('{"status":"error","code":"invalid_configuration"}');
      expect(reads).toBe(0); expect(readRefKey).not.toHaveBeenCalled(); expect(state.connectStore).not.toHaveBeenCalled();
      expect(state.connectCaptureBackupSourceMaintenance).not.toHaveBeenCalled();
      expect(state.loadCatalogConfig).not.toHaveBeenCalled(); expect(state.createCatalogAdapter).not.toHaveBeenCalled();
      expect(artifacts.acquire).not.toHaveBeenCalled(); expect(state.output).toEqual([]);
    }
  });

  it("uses the stopped source facade for keyless artifacts and rejects another facade or role (synthetic only)", async () => {
    const state = createHarness(); await activateCatalog(state); const artifacts = artifactHarness(state);
    const readRefKey = vi.fn(async () => Buffer.alloc(32)); state.dependencies.readRefKey = readRefKey;
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    const [input, profile] = state.connectCaptureBackupSourceMaintenance.mock.calls[0]!;
    expect(profile).toEqual(STOPPED_PROFILE); expect(input).not.toHaveProperty("tenantTelemetryRefKey");
    expect(readRefKey).not.toHaveBeenCalled();
    const source = artifacts.create.mock.calls[0]![0].captureCheckpointStore;
    expect(Object.isFrozen(source)).toBe(true); expect(source).not.toBe(state.store);
    expect(artifacts.operator.assertStoreBinding).toHaveBeenCalledWith(source, "source");
    // The double only compares registered facade identity/role/selection. It
    // cannot prove a native lock, grants, physical DB identity or a binding row.
    await expect(artifacts.operator.assertStoreBinding(state.store, "source")).rejects.toThrow("synthetic_facade_binding_mismatch");
    await expect(artifacts.operator.assertStoreBinding(source, "target")).rejects.toThrow("synthetic_facade_binding_mismatch");
  });

  it("does not load an activation command on stopped continuation paths and rejects an authority target mismatch before resources", async () => {
    const h = await selectedContinuationHarness();
    await h.invoke("replay-selected"); await h.invoke("verify-selected");
    expect(h.loadAuthorityContext).not.toHaveBeenCalled();
    expect(h.bootstrap.mock.calls.map(([, profile]) => profile)).toEqual([STOPPED_PROFILE, STOPPED_PROFILE]);
    expect(h.maintenance.confirmSessionAuthorityBinding).not.toHaveBeenCalled();
    h.artifacts.acquire.mockClear(); h.bootstrap.mockClear(); h.state.createCatalogAdapter.mockClear();
    await expect(h.invoke("activate-selected", { AUTHORITY_MYSQL_URL: MYSQL_URL })).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(h.loadAuthorityContext).not.toHaveBeenCalled(); expect(h.bootstrap).not.toHaveBeenCalled();
    expect(h.artifacts.acquire).not.toHaveBeenCalled(); expect(h.state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(h.maintenance.activateTenantRestoreRuntime).not.toHaveBeenCalled(); expect(h.state.output).toEqual([]);
  });

  it("refuses missing fixed authority configuration before activation can read a key or load a command", async () => {
    const h = await selectedContinuationHarness();
    await h.invoke("replay-selected"); await h.invoke("verify-selected");
    h.artifacts.acquire.mockClear(); h.bootstrap.mockClear();
    const keyCount = h.keys.length;
    await expect(h.invoke("activate-selected", { AUTHORITY_COMMAND_FILE: undefined })).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(h.keys).toHaveLength(keyCount); expect(h.loadAuthorityContext).not.toHaveBeenCalled();
    expect(h.artifacts.acquire).not.toHaveBeenCalled(); expect(h.bootstrap).not.toHaveBeenCalled();
    expect(h.maintenance.activateTenantRestoreRuntime).not.toHaveBeenCalled(); expect(h.state.output).toEqual([]);
  });

  it("does not confirm a fixed binding when the original Memory activation was rejected", async () => {
    const h = await selectedContinuationHarness();
    await h.invoke("replay-selected"); await h.invoke("verify-selected");
    h.maintenance.activateTenantRestoreRuntime.mockRejectedValueOnce(new Error("synthetic_activation_rejected"));
    await expect(h.invoke("activate-selected")).rejects.toMatchObject({ code: "invalid_durable_state" });
    expect((await h.state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))?.phase).toBe("replay_sealed");
    expect(h.maintenance.confirmSessionAuthorityBinding).not.toHaveBeenCalled();
    expect(h.nativeAdmission).not.toHaveBeenCalled(); expect(h.state.output).toEqual([]);
    expect(h.maintenance.close).toHaveBeenCalledOnce(); expect(h.artifacts.operator.close).toHaveBeenCalledOnce();
    expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce(); expect(h.keys.at(-1)!).toEqual(Buffer.alloc(32));
  });

  it("does not emit selected activation success after an unknown binding confirmation (synthetic only)", async () => {
    const h = await selectedContinuationHarness();
    await h.invoke("replay-selected"); await h.invoke("verify-selected");
    h.maintenance.confirmSessionAuthorityBinding.mockRejectedValueOnce(new Error("synthetic_binding_confirmation_unknown"));
    let failure: unknown;
    try { await h.invoke("activate-selected"); } catch (error) { failure = error; }
    expect(JSON.parse(formatBackupCatalogCliError(failure))).toMatchObject({ status: "error", code: "operation_failed",
      restoreMutationMayBeCommitted: true, runtimeActivationMayBeCommitted: true, requiresExactReplay: true });
    expect(h.maintenance.activateTenantRestoreRuntime).toHaveBeenCalledOnce();
    expect((await h.state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))?.phase).toBe("active");
    expect(h.maintenance.confirmSessionAuthorityBinding).toHaveBeenCalledOnce();
    expect(h.nativeAdmission).not.toHaveBeenCalled(); expect(h.state.output).toEqual([]);
    expect(h.maintenance.close).toHaveBeenCalledOnce(); expect(h.artifacts.operator.close).toHaveBeenCalledOnce();
    expect(h.artifacts.verifiedClose).toHaveBeenCalledOnce(); expect(h.keys.at(-1)!).toEqual(Buffer.alloc(32));
    const fixed = h.getAuthorityContext()!.command;
    await h.invoke("activate-selected"); // Explicit exact retry; no second Memory activation.
    expect(h.getAuthorityContext()!.command).toBe(fixed); expect(h.maintenance.activateTenantRestoreRuntime).toHaveBeenCalledOnce();
    expect(h.maintenance.confirmSessionAuthorityBinding).toHaveBeenCalledTimes(2);
    expect(JSON.parse(h.state.output[0]!)).toMatchObject({ status: "ok", runtimeActivated: true });
  });
});


/** Orchestration doubles only: the native different-DB import/forward-fix case uses
 * the actual MySQL source module. These doubles do not prove GCM, native grants or a stopped fleet. */
describe("explicit stopped-local generic prepare orchestration", () => {
  const ACK = "BACKUP_CATALOG_PREPARE_RESTORE_STOPPED_LOCAL_ACK";
  async function preparedHarness() {
    const state = createHarness();
    await activateCatalog(state); await createAndPublish(state, BACKUP_ID_1, "backup-one");
    const source = sourceFacadeDouble(state.store);
    const connect = vi.fn(async (
      _input: Parameters<NonNullable<BackupCatalogCliDependencies["connectCaptureBackupSourceMaintenance"]>>[0],
      _profile: Parameters<NonNullable<BackupCatalogCliDependencies["connectCaptureBackupSourceMaintenance"]>>[1],
    ) => source);
    state.dependencies.connectCaptureBackupSourceMaintenance = connect;
    state.connectStore.mockClear(); vi.mocked(state.storeClose).mockClear();
    vi.mocked(state.catalogAdapter.close).mockClear(); vi.mocked(state.journalAdapter.close).mockClear();
    state.output.length = 0;
    const env = prepareRestoreEnv({ [ACK]: "1" });
    delete env.MYSQL_SCHEMA_METADATA_SCHEMA; delete env.MYSQL_SCHEMA_METADATA_DEFINER_USER;
    delete env.MYSQL_SCHEMA_METADATA_DEFINER_HOST;
    return { state, source, connect, env };
  }

  it("keeps default generic prepare ordinary even when an artifact ACK is inherited", async () => {
    const h = await preparedHarness();
    await runBackupCatalogCli(["prepare-restore"], prepareRestoreEnv({ BACKUP_ARTIFACT_LOCAL_ONLY_ACK: "1" }), h.state.dependencies);
    expect(h.connect).not.toHaveBeenCalled(); expect(h.state.connectStore).toHaveBeenCalledOnce();
    expect(h.state.connectStore.mock.calls[0]![0]).toMatchObject({ migrationMode: "verify", schemaMetadata: SCHEMA_METADATA });
  });

  it("uses only the closed stopped source port without ordinary metadata or artifact authority", async () => {
    const h = await preparedHarness(), artifacts = artifactHarness(h.state);
    await runBackupCatalogCli(["prepare-restore"], h.env, h.state.dependencies);
    expect(h.state.connectStore).not.toHaveBeenCalled(); expect(h.connect).toHaveBeenCalledOnce();
    const [input, profile] = h.connect.mock.calls[0]!;
    expect(profile).toEqual(STOPPED_PROFILE);
    expect(Object.keys(input).sort()).toEqual(["connectionLimit", "fleetStoppedAck", "localOnlyAck", "operationAbortSignal", "url"]);
    expect(input).toMatchObject({ url: MYSQL_URL, connectionLimit: 2, fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" });
    expect(input.operationAbortSignal?.aborted).toBe(true);
    expect(artifacts.acquire).not.toHaveBeenCalled(); expect(artifacts.verify).not.toHaveBeenCalled(); expect(artifacts.imported).not.toHaveBeenCalled();
    expect(await h.state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID)).toMatchObject({ phase: "prepared" });
    expect(JSON.parse(h.state.output[0]!)).toMatchObject({ status: "ok", command: "prepare-restore", restorePhase: "prepared" });
    expect(JSON.parse(h.state.output[0]!)).not.toHaveProperty("artifactVerified");
    expect(h.state.storeClose).toHaveBeenCalledOnce(); expect(h.state.catalogAdapter.close).toHaveBeenCalledOnce();
    expect(h.state.journalAdapter.close).toHaveBeenCalledOnce();
  });

  it.each([
    { command: "prepare-restore", extra: { [ACK]: "" } },
    { command: "prepare-restore", extra: { [ACK]: "0" } },
    { command: "prepare-restore", extra: { [ACK]: "other" } },
    { command: "prepare-restore", extra: { RESTORE_FLEET_STOPPED_ACK: undefined } },
    { command: "prepare-restore", extra: { RESTORE_FLEET_STOPPED_ACK: "0" } },
    { command: "prepare-restore", extra: { NODE_ENV: "production" } },
    { command: "status", extra: {} },
    { command: "create-artifact", extra: {} },
    { command: "activate-selected", extra: {} },
  ])("rejects invalid stopped-local authority before resources ($command / $extra)", async ({ command, extra }) => {
    const state = createHarness(), readKey = vi.fn(async () => Buffer.alloc(32)); state.dependencies.readRefKey = readKey;
    const env = prepareRestoreEnv({ [ACK]: "1", TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/unopened-ref-key", ...extra });
    const error = await runBackupCatalogCli([command], env, state.dependencies).catch((reason: unknown) => reason);
    expect(formatBackupCatalogCliError(error)).toBe('{"status":"error","code":"invalid_configuration"}');
    expect(readKey).not.toHaveBeenCalled(); expect(state.connectStore).not.toHaveBeenCalled();
    expect(state.connectCaptureBackupSourceMaintenance).not.toHaveBeenCalled(); expect(state.loadCatalogConfig).not.toHaveBeenCalled();
    expect(state.createCatalogAdapter).not.toHaveBeenCalled(); expect(state.createJournalAdapters).not.toHaveBeenCalled(); expect(state.output).toEqual([]);
  });

  it("rejects unread accessor authority and a missing source capability without opening resources", async () => {
    const state = createHarness(), env = prepareRestoreEnv(); let reads = 0;
    Object.defineProperty(env, ACK, { enumerable: false, get() { reads++; throw new Error(RESPONSE_LOSS_MARKER); } });
    await expect(runBackupCatalogCli(["prepare-restore"], env, state.dependencies)).rejects.toThrow("invalid_configuration");
    expect(reads).toBe(0);
    const authorityEnv = prepareRestoreEnv({ [ACK]: "1" });
    Object.defineProperty(authorityEnv, "AUTHORITY_MYSQL_URL", { enumerable: false, get() { reads++; throw new Error(RESPONSE_LOSS_MARKER); } });
    await expect(runBackupCatalogCli(["prepare-restore"], authorityEnv, state.dependencies)).rejects.toThrow("invalid_configuration");
    expect(reads).toBe(0); delete state.dependencies.connectCaptureBackupSourceMaintenance;
    await expect(runBackupCatalogCli(["prepare-restore"], prepareRestoreEnv({ [ACK]: "1" }), state.dependencies))
      .rejects.toThrow("invalid_configuration");
    expect(state.connectStore).not.toHaveBeenCalled(); expect(state.createCatalogAdapter).not.toHaveBeenCalled(); expect(state.output).toEqual([]);
  });

  it("rejects an actual production process even when the supplied environment is nonproduction", async () => {
    const state = createHarness(), previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(runBackupCatalogCli(["prepare-restore"], prepareRestoreEnv({ [ACK]: "1", NODE_ENV: "test" }), state.dependencies))
        .rejects.toThrow("invalid_configuration");
      expect(state.connectStore).not.toHaveBeenCalled(); expect(state.connectCaptureBackupSourceMaintenance).not.toHaveBeenCalled();
      expect(state.createCatalogAdapter).not.toHaveBeenCalled(); expect(state.createJournalAdapters).not.toHaveBeenCalled();
      expect(state.output).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
    }
  });

  it("preserves an original source factory refusal, closes adapters and never falls back", async () => {
    const h = await preparedHarness(), sourceFailure = new Error("synthetic_source_integrity_refusal");
    h.connect.mockRejectedValueOnce(sourceFailure);
    await expect(runBackupCatalogCli(["prepare-restore"], h.env, h.state.dependencies)).rejects.toBe(sourceFailure);
    expect(h.connect).toHaveBeenCalledOnce(); expect(h.state.connectStore).not.toHaveBeenCalled();
    expect(h.state.storeClose).not.toHaveBeenCalled(); expect(h.state.catalogAdapter.close).toHaveBeenCalledOnce();
    expect(h.state.journalAdapter.close).toHaveBeenCalledOnce(); expect(h.state.output).toEqual([]);
  });

  it("joins the original late source factory and held close before wiping its key or reporting success", async ({ signal }) => {
    const h = await preparedHarness(), key = Buffer.alloc(32, 0x37);
    h.env.TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE = "/private/held-ref-key";
    h.state.dependencies.readRefKey = vi.fn(async () => key);
    let returnSource!: (value: TenantTelemetryCaptureBackupSourceMaintenance) => void;
    let closeSource!: () => void;
    const factory = new Promise<TenantTelemetryCaptureBackupSourceMaintenance>(resolve => { returnSource = resolve; });
    const closing = new Promise<void>(resolve => { closeSource = resolve; });
    const sourceClose = vi.fn(() => closing), source = Object.freeze({ ...h.source, close: sourceClose });
    h.connect.mockImplementationOnce(() => factory);
    const release = () => { returnSource(source); closeSource(); };
    signal.addEventListener("abort", release, { once: true }); if (signal.aborted) release();
    const operation = runBackupCatalogCli(["prepare-restore"], h.env, h.state.dependencies);
    let settled = false; const observed = operation.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.waitFor(() => expect(h.connect).toHaveBeenCalledOnce());
      expect(h.connect.mock.results[0]?.value).toBe(factory); expect(settled).toBe(false);
      expect(sourceClose).not.toHaveBeenCalled(); expect(h.state.catalogAdapter.close).not.toHaveBeenCalled();
      returnSource(source);
      await vi.waitFor(() => expect(sourceClose).toHaveBeenCalledOnce());
      expect(sourceClose.mock.results[0]?.value).toBe(closing); expect(settled).toBe(false);
      expect(key).toEqual(Buffer.alloc(32, 0x37)); expect(h.state.output).toEqual([]);
      closeSource(); await operation;
      expect(key).toEqual(Buffer.alloc(32)); expect(h.state.connectStore).not.toHaveBeenCalled();
      expect(h.state.catalogAdapter.close).toHaveBeenCalledOnce(); expect(h.state.journalAdapter.close).toHaveBeenCalledOnce();
    } finally {
      release(); await Promise.allSettled([operation, observed]); signal.removeEventListener("abort", release);
    }
  });

  it.each(["body", "close"] as const)("preserves an undefined %s failure while actually closing every resource", async (phase) => {
    const h = await preparedHarness();
    const sourceClose = vi.fn(async () => { if (phase === "close") throw undefined; throw new Error("later-close-error"); });
    const source = Object.freeze({ ...h.source, close: sourceClose,
      ...(phase === "body" ? { getTenantBackupCatalogControl: async () => { throw undefined; } } : {}) });
    h.connect.mockResolvedValueOnce(source);
    let rejected = false, failure: unknown;
    try { await runBackupCatalogCli(["prepare-restore"], h.env, h.state.dependencies); }
    catch (reason) { rejected = true; failure = reason; }
    expect(rejected).toBe(true); expect(failure).toBeUndefined(); expect(h.state.output).toEqual([]);
    expect(sourceClose).toHaveBeenCalledOnce(); expect(h.state.catalogAdapter.close).toHaveBeenCalledOnce();
    expect(h.state.journalAdapter.close).toHaveBeenCalledOnce(); expect(h.state.connectStore).not.toHaveBeenCalled();
  });

  it("requires an explicit exact retry after a prepared commit loses its response", async () => {
    const h = await preparedHarness(), original = h.state.store.prepareTenantRestoreReplayFromBackup.bind(h.state.store);
    const prepare = vi.spyOn(h.state.store, "prepareTenantRestoreReplayFromBackup"); let lose = true;
    prepare.mockImplementation(async (input) => {
      const value = await original(input); if (lose) { lose = false; throw new Error(RESPONSE_LOSS_MARKER); } return value;
    });
    // Capture the changed delegate without wrapping it into a full SessionStore role.
    h.connect.mockImplementation(async () => sourceFacadeDouble(h.state.store));
    const reserve = vi.spyOn(h.state.catalogAdapter, "reserveRestore");
    try {
      await expect(runBackupCatalogCli(["prepare-restore"], h.env, h.state.dependencies)).rejects.toThrow(RESPONSE_LOSS_MARKER);
      expect(prepare).toHaveBeenCalledOnce(); expect(reserve).toHaveBeenCalledOnce(); expect(h.state.output).toEqual([]);
      const before = await h.state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID);
      expect(before).toMatchObject({ phase: "reserved" });
      await runBackupCatalogCli(["prepare-restore"], h.env, h.state.dependencies);
      expect(prepare).toHaveBeenCalledTimes(2); expect(prepare.mock.calls[1]![0]).toEqual(prepare.mock.calls[0]![0]);
      expect(await h.state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID)).toEqual(before);
      expect(JSON.parse(h.state.output[0]!)).toMatchObject({ disposition: "exact_replay", restorePhase: "prepared" });
      expect(h.state.connectStore).not.toHaveBeenCalled();
    } finally { prepare.mockRestore(); reserve.mockRestore(); }
  });
});


/** Memory orchestration only. Native imported-target admission is covered separately;
 * no double here claims MySQL metadata, physical bytes, a GCM capability or fleet fencing. */
describe("explicit runtime-maintenance generic prepare orchestration", () => {
  const ACK = "BACKUP_CATALOG_PREPARE_RESTORE_RUNTIME_MAINTENANCE_ACK";
  const NAMES = ["close", "getTenantBackupCatalogControl", "getTenantRestoreJournalControl",
    "mirrorTenantBackupCatalogEvent", "preflightTenantRestoreReplayFromBackup", "prepareTenantRestoreReplayFromBackup"].sort();
  function port(state: Harness): MysqlBackupCatalogPrepareMaintenance {
    return Object.freeze({
      getTenantBackupCatalogControl: state.store.getTenantBackupCatalogControl.bind(state.store),
      mirrorTenantBackupCatalogEvent: state.store.mirrorTenantBackupCatalogEvent.bind(state.store),
      preflightTenantRestoreReplayFromBackup: state.store.preflightTenantRestoreReplayFromBackup.bind(state.store),
      prepareTenantRestoreReplayFromBackup: state.store.prepareTenantRestoreReplayFromBackup.bind(state.store),
      getTenantRestoreJournalControl: state.store.getTenantRestoreJournalControl.bind(state.store),
      close: state.storeClose,
    });
  }
  async function fixture() {
    const state = createHarness();
    await activateCatalog(state); await createAndPublish(state, BACKUP_ID_1, "backup-one");
    // The original readable source creates the permanent reservation BEFORE this target role.
    await runBackupCatalogCli(["prepare-restore"], prepareRestoreEnv(), state.dependencies);
    const facade = port(state);
    const connect = vi.fn(async (
      _options: Parameters<NonNullable<BackupCatalogCliDependencies["connectBackupCatalogPrepareMaintenance"]>>[0],
      _profile: Parameters<NonNullable<BackupCatalogCliDependencies["connectBackupCatalogPrepareMaintenance"]>>[1],
    ) => facade);
    state.dependencies.connectBackupCatalogPrepareMaintenance = connect;
    state.connectStore.mockClear(); state.connectCaptureBackupSourceMaintenance.mockClear();
    vi.mocked(state.storeClose).mockClear(); state.output.length = 0;
    return { state, facade, connect, env: prepareRestoreEnv({ [ACK]: "1" }) };
  }

  it("uses only the six recovery metadata methods with exact target metadata in production", async () => {
    const f = await fixture(), previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await runBackupCatalogCli(["prepare-restore"], { ...f.env, NODE_ENV: "test" }, f.state.dependencies);
      expect(Object.keys(f.facade).sort()).toEqual(NAMES);
      expect(f.connect).toHaveBeenCalledOnce(); expect(f.state.connectStore).not.toHaveBeenCalled();
      expect(f.state.connectCaptureBackupSourceMaintenance).not.toHaveBeenCalled();
      const [options, profile] = f.connect.mock.calls[0]!;
      expect(profile).toEqual({ kind: "runtime-maintenance", schemaMetadata: SCHEMA_METADATA });
      expect(Object.keys(options).sort()).toEqual(["connectionLimit", "operationAbortSignal", "url"]);
      expect(options).toMatchObject({ url: MYSQL_URL, connectionLimit: 2 });
      expect(options.operationAbortSignal?.aborted).toBe(true);
      expect(f.state.loadCatalogConfig).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({ production: true }));
      expect(JSON.parse(f.state.output[0]!)).toMatchObject({ command: "prepare-restore", restorePhase: "prepared" });
      expect(JSON.parse(f.state.output[0]!)).not.toHaveProperty("runtimeActivated");
      expect(f.state.storeClose).toHaveBeenCalledOnce();
    } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
  });

  it("keeps the existing ordinary default and never derives this role from artifact ACK", async () => {
    const f = await fixture();
    await runBackupCatalogCli(["prepare-restore"], prepareRestoreEnv({ BACKUP_ARTIFACT_LOCAL_ONLY_ACK: "1" }), f.state.dependencies);
    expect(f.connect).not.toHaveBeenCalled(); expect(f.state.connectStore).toHaveBeenCalledOnce();
  });

  it.each([
    { command: "prepare-restore", extra: { [ACK]: "" } },
    { command: "prepare-restore", extra: { [ACK]: "0" } },
    { command: "prepare-restore", extra: { RESTORE_FLEET_STOPPED_ACK: undefined } },
    { command: "prepare-restore", extra: { BACKUP_CATALOG_PREPARE_RESTORE_STOPPED_LOCAL_ACK: "1" } },
    { command: "prepare-restore", extra: { BACKUP_ARTIFACT_LOCAL_ONLY_ACK: "1" } },
    { command: "prepare-restore", extra: { AUTHORITY_UNUSED: undefined } },
    { command: "prepare-restore", extra: { MYSQL_SCHEMA_METADATA_SCHEMA: undefined } },
    { command: "status", extra: {} },
    { command: "activate-selected", extra: {} },
  ])("rejects invalid or mixed recovery authority before resources ($command / $extra)", async ({ command, extra }) => {
    const f = await fixture(), readKey = vi.fn(async () => Buffer.alloc(32)); f.state.dependencies.readRefKey = readKey;
    f.state.loadCatalogConfig.mockClear(); f.state.createCatalogAdapter.mockClear(); f.state.createJournalAdapters.mockClear();
    await expect(runBackupCatalogCli([command], { ...f.env,
      TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/not-opened", ...extra }, f.state.dependencies))
      .rejects.toThrow("invalid_configuration");
    expect(readKey).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
    expect(f.state.connectStore).not.toHaveBeenCalled(); expect(f.state.connectCaptureBackupSourceMaintenance).not.toHaveBeenCalled();
    expect(f.state.loadCatalogConfig).not.toHaveBeenCalled(); expect(f.state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(f.state.createJournalAdapters).not.toHaveBeenCalled(); expect(f.state.output).toEqual([]);
  });

  it("refuses a first reservation in the recovery role instead of reversing the source/import order", async () => {
    const state = createHarness(); await activateCatalog(state); await createAndPublish(state, BACKUP_ID_1, "backup-one");
    const facade = port(state), connect = vi.fn(async () => facade);
    state.dependencies.connectBackupCatalogPrepareMaintenance = connect;
    const reserve = vi.spyOn(state.catalogAdapter, "reserveRestore"), prepare = vi.spyOn(state.store, "prepareTenantRestoreReplayFromBackup");
    state.output.length = 0;
    try {
      await expect(runBackupCatalogCli(["prepare-restore"], prepareRestoreEnv({ [ACK]: "1" }), state.dependencies))
        .rejects.toThrow("catalog_not_ready");
      expect(reserve).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(state.output).toEqual([]);
      expect(await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID)).toBeNull();
    } finally { reserve.mockRestore(); prepare.mockRestore(); }
  });

  it("preserves the original exact terminal-reservation refusal instead of treating historical presence as usable", async () => {
    const f = await fixture(), reservation = await f.state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID);
    if (!reservation) throw Error("fixture_missing_reserved_source");
    await f.state.store.abortTenantRestoreReplay(RESTORE_RUN_ID);
    const resolved = await f.state.catalogAdapter.resolveRestore({ restoreRunId: RESTORE_RUN_ID,
      reservationReceiptSha256: reservation.reservationReceiptSha256, phase: "aborted" });
    await f.state.store.resolveTenantBackupRuntimeReservation(resolved);
    const reserve = vi.spyOn(f.state.catalogAdapter, "reserveRestore");
    try {
      await expect(runBackupCatalogCli(["prepare-restore"], f.env, f.state.dependencies))
        .rejects.toBeInstanceOf(TenantBackupCatalogConflictError);
      expect(reserve).not.toHaveBeenCalled(); expect(f.state.output).toEqual([]);
      expect(await f.state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID)).toMatchObject({ phase: "aborted" });
    } finally { reserve.mockRestore(); }
  });

  it("does not read accessor ACKs, fleet acknowledgements or metadata", async () => {
    for (const name of [ACK, "RESTORE_FLEET_STOPPED_ACK", "MYSQL_SCHEMA_METADATA_SCHEMA"]) {
      const f = await fixture(); let reads = 0;
      Object.defineProperty(f.env, name, { enumerable: true, get() { reads++; throw Error(RESPONSE_LOSS_MARKER); } });
      f.state.createCatalogAdapter.mockClear();
      await expect(runBackupCatalogCli(["prepare-restore"], f.env, f.state.dependencies)).rejects.toThrow("invalid_configuration");
      expect(reads).toBe(0); expect(f.connect).not.toHaveBeenCalled(); expect(f.state.createCatalogAdapter).not.toHaveBeenCalled();
    }
  });

  it("requires the actual narrow dependency and never falls back after its refusal", async () => {
    const f = await fixture(), failure = new Error("synthetic-native-profile-refusal");
    f.connect.mockRejectedValueOnce(failure);
    await expect(runBackupCatalogCli(["prepare-restore"], f.env, f.state.dependencies)).rejects.toBe(failure);
    expect(f.state.connectStore).not.toHaveBeenCalled(); expect(f.state.output).toEqual([]);
    delete f.state.dependencies.connectBackupCatalogPrepareMaintenance;
    f.state.createCatalogAdapter.mockClear();
    await expect(runBackupCatalogCli(["prepare-restore"], f.env, f.state.dependencies)).rejects.toThrow("invalid_configuration");
    expect(f.state.createCatalogAdapter).not.toHaveBeenCalled();
  });

  it("rejects other native maintenance roles before making a connection", async () => {
    // Runtime negative: compile-time narrowing is insufficient at the JS boundary.
    // @ts-expect-error stopped operator is deliberately not a runtime-maintenance role
    await expect(MysqlSessionStore.connectBackupCatalogPrepareMaintenance({ url: "mysql://unopened/invalid" }, STOPPED_PROFILE))
      .rejects.toThrow("Backup catalog prepare maintenance profile is invalid.");
  });

  it("joins an accepted late native result and close before wiping its original key", async ({ signal }) => {
    const f = await fixture(), key = Buffer.alloc(32, 0x47);
    f.env.TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE = "/private/held-recovery-key";
    f.state.dependencies.readRefKey = async () => key;
    let accept!: (value: MysqlBackupCatalogPrepareMaintenance) => void, close!: () => void;
    const factory = new Promise<MysqlBackupCatalogPrepareMaintenance>(resolve => { accept = resolve; });
    const closing = new Promise<void>(resolve => { close = resolve; });
    const closePort = vi.fn(() => closing), facade = Object.freeze({ ...f.facade, close: closePort });
    f.connect.mockImplementationOnce(() => factory);
    const release = () => { accept(facade); close(); };
    signal.addEventListener("abort", release, { once: true }); if (signal.aborted) release();
    const operation = runBackupCatalogCli(["prepare-restore"], f.env, f.state.dependencies);
    let settled = false; const observed = operation.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
      expect(f.connect.mock.results[0]?.value).toBe(factory); expect(settled).toBe(false);
      expect(key).toEqual(Buffer.alloc(32, 0x47)); accept(facade);
      await vi.waitFor(() => expect(closePort).toHaveBeenCalledOnce());
      expect(closePort.mock.results[0]?.value).toBe(closing); expect(settled).toBe(false); expect(f.state.output).toEqual([]);
      expect(key).toEqual(Buffer.alloc(32, 0x47)); close(); await operation;
      expect(key).toEqual(Buffer.alloc(32));
    } finally { release(); await Promise.allSettled([operation, observed]); signal.removeEventListener("abort", release); }
  });

  it.each(["body", "close"] as const)("keeps an undefined %s first error while closing all actual resources", async phase => {
    const f = await fixture(), facade = Object.freeze({ ...f.facade,
      close: vi.fn(async () => { if (phase === "close") throw undefined; throw Error("later-close"); }),
      ...(phase === "body" ? { getTenantBackupCatalogControl: async () => { throw undefined; } } : {}) });
    f.connect.mockResolvedValueOnce(facade);
    let failed = false, reason: unknown;
    try { await runBackupCatalogCli(["prepare-restore"], f.env, f.state.dependencies); }
    catch (error) { failed = true; reason = error; }
    expect(failed).toBe(true); expect(reason).toBeUndefined(); expect(f.state.output).toEqual([]);
    expect(facade.close).toHaveBeenCalledOnce(); expect(f.state.catalogAdapter.close).toHaveBeenCalled();
    expect(f.state.journalAdapter.close).toHaveBeenCalled(); expect(f.state.connectStore).not.toHaveBeenCalled();
  });

  it("keeps the same reservation and exact inputs after a prepare response is lost", async () => {
    const f = await fixture(), original = f.state.store.prepareTenantRestoreReplayFromBackup.bind(f.state.store);
    const call = vi.spyOn(f.state.store, "prepareTenantRestoreReplayFromBackup"); let lost = false;
    call.mockImplementation(async input => { const result = await original(input); if (!lost) { lost = true; throw Error(RESPONSE_LOSS_MARKER); } return result; });
    f.connect.mockImplementation(async () => port(f.state));
    try {
      await expect(runBackupCatalogCli(["prepare-restore"], f.env, f.state.dependencies)).rejects.toThrow(RESPONSE_LOSS_MARKER);
      expect(f.state.output).toEqual([]); const before = await f.state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID);
      await runBackupCatalogCli(["prepare-restore"], f.env, f.state.dependencies);
      expect(call).toHaveBeenCalledTimes(2); expect(call.mock.calls[1]![0]).toEqual(call.mock.calls[0]![0]);
      expect(await f.state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID)).toEqual(before);
      expect(JSON.parse(f.state.output[0]!)).toMatchObject({ disposition: "exact_replay", restorePhase: "prepared" });
      expect(f.state.connectStore).not.toHaveBeenCalled();
    } finally { call.mockRestore(); }
  });
});
