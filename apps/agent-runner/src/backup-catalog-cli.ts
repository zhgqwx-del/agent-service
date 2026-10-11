import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  MysqlSessionStore,
  TenantBackupCatalogAdapterConflictError,
  TenantBackupCatalogAdapterCorruptError,
  TenantBackupCatalogConflictError,
  TenantBackupCatalogIntegrityError,
  TenantBackupCatalogNotReadyError,
  TenantRestoreJournalConflictError,
  TenantRestoreJournalCorruptError,
  tenantRestoreRuntimeEpochSha256,
  validateBlobStorageControlRecord,
  validateTenantBackupCatalogAdapterEvent,
  validateTenantBackupCatalogControlRecord,
  validateTenantBackupCatalogEntry,
  validateTenantBackupCatalogEviction,
  validateTenantBackupCatalogHead,
  validateTenantBackupRuntimeReservation,
  validateTenantRestoreJournalControlRecord,
  validateTenantRestoreJournalRemoteHead,
  validateTenantRestoreReplayRunRecord,
  validateTenantRestoreReplaySealedTarget,
  validateTenantRestoreRuntimeControlRecord,
  type BlobStorageControlStore,
  type RestoreReplayStore,
  type TenantBackupCatalogAdapter,
  type TenantBackupCatalogAdapterEvent,
  type TenantBackupCatalogStore,
  type TenantBackupCatalogControlRecord,
  type TenantBackupCatalogEviction,
  type TenantBackupCatalogHead,
  type TenantBackupCatalogEntry,
  type TenantBackupEvictionPlan,
  type TenantRestoreJournalStore,
  type TenantRestoreJournalAdapter,
  type TenantRestoreReplaySealedTarget,
} from "@agent-service/store";
import { z } from "zod";
import {
  createTenantBackupCatalogAdapter,
  loadTenantBackupCatalogConfig,
  type TenantBackupCatalogRuntimeConfig,
} from "./tenant-backup-catalog-config.js";
import {
  createTenantRestoreJournalAdapters,
  loadTenantRestoreJournalConfig,
  type TenantRestoreJournalRuntimeConfig,
} from "./tenant-restore-journal-config.js";

const COMMANDS = [
  "status",
  "activate",
  "begin-backup",
  "publish-backup",
  "list",
  "prepare-restore",
  "resolve-restore",
  "prepare-eviction",
  "record-eviction",
  "reconcile",
] as const;
type BackupCatalogCommand = (typeof COMMANDS)[number];

const BACKUP_ID = /^backup_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVICTION_ID = /^backup_evict_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESTORE_RUN_ID = /^restore_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_PAGE_SIZE = 100;

type BackupCatalogCliErrorCode =
  | "invalid_command"
  | "invalid_configuration"
  | "invalid_durable_state"
  | "catalog_conflict"
  | "catalog_corrupt"
  | "catalog_not_ready"
  | "journal_conflict"
  | "operation_failed";

class BackupCatalogCliError extends Error {
  constructor(readonly code: BackupCatalogCliErrorCode) {
    super(code);
    this.name = "BackupCatalogCliError";
  }
}

type BackupCatalogCliStore = TenantBackupCatalogStore
  & TenantRestoreJournalStore
  & RestoreReplayStore
  & BlobStorageControlStore
  & { close(): Promise<void> };

type RestoreAdapter = TenantRestoreJournalAdapter & {
  validateStartup(): Promise<void>;
};

export interface BackupCatalogCliDependencies {
  connectStore(options: {
    url: string;
    connectionLimit: number;
    migrationMode: "verify";
  }): Promise<BackupCatalogCliStore>;
  loadCatalogConfig(
    env: NodeJS.ProcessEnv,
    context: Parameters<typeof loadTenantBackupCatalogConfig>[1],
  ): TenantBackupCatalogRuntimeConfig | undefined;
  createCatalogAdapter(config: TenantBackupCatalogRuntimeConfig): TenantBackupCatalogAdapter;
  loadJournalConfig(
    env: NodeJS.ProcessEnv,
    context: Parameters<typeof loadTenantRestoreJournalConfig>[1],
  ): TenantRestoreJournalRuntimeConfig | undefined;
  createJournalAdapters(config: TenantRestoreJournalRuntimeConfig): readonly RestoreAdapter[];
  writeLine(line: string): void;
}

const MysqlEnv = z.object({
  MYSQL_URL: z.string().min(1).max(4_096).refine((value) => {
    if (value.trim() !== value) return false;
    try {
      return new URL(value).protocol === "mysql:";
    } catch {
      return false;
    }
  }),
});

const BackupEnv = z.object({ BACKUP_ID: z.string().regex(BACKUP_ID) });
const BeginBackupEnv = BackupEnv.extend({
  RESTORE_FLEET_STOPPED_ACK: z.literal("1"),
});
const ActivateEnv = z.object({
  BACKUP_CATALOG_ACTIVATION_ACK: z.literal("1"),
  RESTORE_FLEET_STOPPED_ACK: z.literal("1"),
});
const PublishEnv = BackupEnv.extend({
  SOURCE_SNAPSHOT_SHA256: z.string().regex(SHA256),
  SOURCE_BACKUP_SHA256: z.string().regex(SHA256),
  BACKUP_ARTIFACT_MANIFEST_SHA256: z.string().regex(SHA256),
  BACKUP_PROVIDER_EVIDENCE_SHA256: z.string().regex(SHA256),
});
const PrepareRestoreEnv = BackupEnv.extend({
  RESTORE_RUN_ID: z.string().regex(RESTORE_RUN_ID),
  BACKUP_RUNTIME_EPOCH_ID: z.string().regex(SAFE_ID),
  SOURCE_BACKUP_SHA256: z.string().regex(SHA256),
  RESTORE_FLEET_STOPPED_ACK: z.literal("1"),
});
const ResolveRestoreEnv = z.object({
  RESTORE_RUN_ID: z.string().regex(RESTORE_RUN_ID),
  RESTORE_FLEET_STOPPED_ACK: z.literal("1"),
});
const EvictionEnv = BackupEnv.extend({
  BACKUP_EVICTION_ID: z.string().regex(EVICTION_ID),
  RESTORE_FLEET_STOPPED_ACK: z.literal("1"),
});
const RecordEvictionEnv = EvictionEnv.extend({
  BACKUP_PHYSICAL_ABSENCE_ACK: z.literal("1"),
  EXTERNAL_TOMBSTONE_SHA256: z.string().regex(SHA256),
});

const DEFAULT_DEPENDENCIES: BackupCatalogCliDependencies = {
  connectStore: (options) => MysqlSessionStore.connect(options),
  loadCatalogConfig: (env, context) => loadTenantBackupCatalogConfig(env, context),
  createCatalogAdapter: (config) => createTenantBackupCatalogAdapter(config),
  loadJournalConfig: (env, context) => loadTenantRestoreJournalConfig(env, context),
  createJournalAdapters: (config) => createTenantRestoreJournalAdapters(config),
  writeLine: (line) => process.stdout.write(`${line}\n`),
};

function cliError(code: BackupCatalogCliErrorCode): BackupCatalogCliError {
  return new BackupCatalogCliError(code);
}

function parseCommand(argv: readonly string[]): BackupCatalogCommand {
  if (argv.length !== 1 || !(COMMANDS as readonly string[]).includes(argv[0]!)) {
    throw cliError("invalid_command");
  }
  return argv[0] as BackupCatalogCommand;
}

function parsePageSize(env: NodeJS.ProcessEnv): number {
  const raw = env.BACKUP_CATALOG_PAGE_SIZE;
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  if (!/^[1-9][0-9]*$/.test(raw)) throw cliError("invalid_configuration");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw cliError("invalid_configuration");
  }
  return value;
}

function assertCatalogIdentity(
  control: TenantBackupCatalogControlRecord,
  config: TenantBackupCatalogRuntimeConfig,
): asserts control is Extract<TenantBackupCatalogControlRecord, { state: "active" }> {
  validateTenantBackupCatalogControlRecord(control);
  if (control.state !== "active"
    || control.adapterProtocol !== config.adapterProtocol
    || control.catalogNamespaceSha256 !== config.catalogNamespaceSha256
    || control.catalogTargetSha256 !== config.catalogTargetSha256
    || control.failureDomainSha256 !== config.failureDomainSha256
    || control.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256) {
    throw cliError("invalid_durable_state");
  }
}

function assertHeadIdentity(
  head: TenantBackupCatalogHead,
  config: TenantBackupCatalogRuntimeConfig,
): void {
  validateTenantBackupCatalogHead(head);
  if (head.adapterProtocol !== config.adapterProtocol
    || head.catalogNamespaceSha256 !== config.catalogNamespaceSha256
    || head.catalogTargetSha256 !== config.catalogTargetSha256
    || head.failureDomainSha256 !== config.failureDomainSha256) {
    throw cliError("catalog_conflict");
  }
}

function loadCatalogRuntimeConfig(
  env: NodeJS.ProcessEnv,
  dependencies: BackupCatalogCliDependencies,
  requireRetentionPolicy: boolean,
): TenantBackupCatalogRuntimeConfig {
  const blobS3Bucket = env.BLOB_STORE === "s3" ? env.BLOB_S3_BUCKET : undefined;
  const restoreJournalS3Bucket = env.RESTORE_JOURNAL_S3_BUCKET;
  const config = dependencies.loadCatalogConfig(env, {
    production: env.NODE_ENV === "production",
    store: "mysql",
    ...(blobS3Bucket === undefined ? {} : { blobS3Bucket }),
    ...(restoreJournalS3Bucket === undefined ? {} : { restoreJournalS3Bucket }),
    ...(requireRetentionPolicy ? { requireRetentionPolicy: true } : {}),
  });
  if (!config) throw cliError("invalid_configuration");
  return config;
}

function loadRestoreRuntimeConfig(
  env: NodeJS.ProcessEnv,
  epochId: string,
  dependencies: BackupCatalogCliDependencies,
): TenantRestoreJournalRuntimeConfig {
  if (env.RESTORE_JOURNAL_RUNTIME_EPOCH_ID !== undefined
    && env.RESTORE_JOURNAL_RUNTIME_EPOCH_ID !== epochId) {
    throw cliError("invalid_configuration");
  }
  const journalEnv = { ...env, RESTORE_JOURNAL_RUNTIME_EPOCH_ID: epochId };
  const blobS3Bucket = env.BLOB_STORE === "s3" ? env.BLOB_S3_BUCKET : undefined;
  const config = dependencies.loadJournalConfig(journalEnv, {
    production: env.NODE_ENV === "production",
    store: "mysql",
    ...(blobS3Bucket === undefined ? {} : { blobS3Bucket }),
  });
  if (!config) throw cliError("invalid_configuration");
  return config;
}

function sameDescriptor(
  target: TenantRestoreReplaySealedTarget,
  descriptor: TenantRestoreJournalRuntimeConfig["targets"][number]["descriptor"],
): boolean {
  return target.targetOrdinal === descriptor.targetOrdinal
    && target.targetSha256 === descriptor.targetSha256
    && target.failureDomainSha256 === descriptor.failureDomainSha256
    && target.adapterProtocol === descriptor.adapterProtocol
    && target.journalNamespaceSha256 === descriptor.journalNamespaceSha256;
}

async function readRestoreJournalHeads(
  config: TenantRestoreJournalRuntimeConfig,
  adapters: readonly RestoreAdapter[],
): Promise<TenantRestoreReplaySealedTarget[]> {
  if (adapters.length !== config.targets.length) throw cliError("invalid_configuration");
  const result: TenantRestoreReplaySealedTarget[] = [];
  for (const [targetOrdinal, configured] of config.targets.entries()) {
    const adapter = adapters[targetOrdinal];
    if (!adapter
      || adapter.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256
      || adapter.adapterProtocol !== configured.descriptor.adapterProtocol
      || adapter.journalNamespaceSha256 !== configured.descriptor.journalNamespaceSha256
      || adapter.targetSha256 !== configured.descriptor.targetSha256
      || adapter.failureDomainSha256 !== configured.descriptor.failureDomainSha256) {
      throw cliError("invalid_configuration");
    }
    const head = await adapter.readHead();
    validateTenantRestoreJournalRemoteHead(head);
    const sealed: TenantRestoreReplaySealedTarget = {
      ...configured.descriptor,
      logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
      sealedRemoteSequence: head.remoteSequence,
      sealedHeadRootSha256: head.headRootSha256,
    };
    validateTenantRestoreReplaySealedTarget(sealed);
    if (!sameDescriptor(sealed, configured.descriptor)) throw cliError("journal_conflict");
    result.push(sealed);
  }
  return result;
}

async function countRecoverable(store: BackupCatalogCliStore): Promise<number> {
  let count = 0;
  let afterBackupId: string | undefined;
  for (;;) {
    const page = await store.listRecoverableTenantBackups({
      limit: 1_000,
      ...(afterBackupId === undefined ? {} : { afterBackupId }),
    });
    for (const entry of page) validateTenantBackupCatalogEntry(entry);
    count += page.length;
    if (page.length < 1_000) return count;
    afterBackupId = page.at(-1)!.backupId;
  }
}

function exactAvailability(entry: TenantBackupCatalogEntry, event: Extract<
  TenantBackupCatalogAdapterEvent,
  { eventType: "backup_recoverable" }
>["result"]): boolean {
  return entry.backupId === event.backupId
    && entry.controlEvidenceSha256 === event.controlEvidenceSha256
    && entry.logicalDatabaseNamespaceSha256 === event.logicalDatabaseNamespaceSha256
    && entry.retentionPolicySha256 === event.retentionPolicySha256
    && entry.retentionUntilDbMs === event.retentionUntilDbMs
    && entry.registeredAtDbMs === event.registeredAtDbMs
    && entry.adapterProtocol === event.adapterProtocol
    && entry.catalogNamespaceSha256 === event.catalogNamespaceSha256
    && entry.catalogTargetSha256 === event.catalogTargetSha256
    && entry.failureDomainSha256 === event.failureDomainSha256
    && entry.anchorSha256 === event.anchorSha256
    && entry.sourceSnapshotSha256 === event.sourceSnapshotSha256
    && entry.sourceBackupSha256 === event.sourceBackupSha256
    && entry.artifactManifestSha256 === event.artifactManifestSha256
    && entry.providerEvidenceSha256 === event.providerEvidenceSha256
    && entry.availabilityOperationSha256 === event.availabilityOperationSha256
    && entry.availabilityReceiptSha256 === event.availabilityReceiptSha256
    && entry.catalogSequence === event.catalogSequence
    && entry.previousCatalogEventRootSha256 === event.previousCatalogEventRootSha256
    && entry.catalogEventRootSha256 === event.catalogEventRootSha256
    && entry.catalogEventSha256 === event.catalogEventSha256
    && entry.entrySha256 === event.entrySha256;
}

function evictionPlanFromRecord(
  eviction: TenantBackupCatalogEviction,
): TenantBackupEvictionPlan {
  validateTenantBackupCatalogEviction(eviction);
  return {
    evictionId: eviction.evictionId,
    backupId: eviction.backupId,
    anchorSha256: eviction.anchorSha256,
    entrySha256: eviction.entrySha256,
    sourceSnapshotSha256: eviction.sourceSnapshotSha256,
    sourceBackupSha256: eviction.sourceBackupSha256,
    artifactManifestSha256: eviction.artifactManifestSha256,
    providerEvidenceSha256: eviction.providerEvidenceSha256,
    controlEvidenceSha256: eviction.controlEvidenceSha256,
    retentionPolicySha256: eviction.retentionPolicySha256,
    retentionUntilDbMs: eviction.retentionUntilDbMs,
    expectedCatalogSequence: eviction.expectedCatalogSequence,
    expectedCatalogEventRootSha256: eviction.expectedCatalogEventRootSha256,
    evictionOperationSha256: eviction.evictionOperationSha256,
    planSha256: eviction.planSha256,
  };
}

async function reconcileExternalChain(
  store: BackupCatalogCliStore,
  adapter: TenantBackupCatalogAdapter,
  pageSize: number,
): Promise<{ eventCount: number; projectedCount: number }> {
  const sealedHead = await adapter.readHead();
  validateTenantBackupCatalogHead(sealedHead);
  let sequence = 0;
  let root = EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256;
  let eventCount = 0;
  let projectedCount = 0;
  while (sequence < sealedHead.catalogSequence) {
    const page = await adapter.scanEvents({
      afterCatalogSequence: sequence,
      afterCatalogEventRootSha256: root,
      sealedHead,
      limit: pageSize,
    });
    if (page.events.length === 0 && !page.complete) throw cliError("catalog_corrupt");
    for (const event of page.events) {
      validateTenantBackupCatalogAdapterEvent(event);
      eventCount += 1;
      const mirrored = await store.mirrorTenantBackupCatalogEvent({
        adapterProtocol: sealedHead.adapterProtocol,
        catalogNamespaceSha256: sealedHead.catalogNamespaceSha256,
        catalogTargetSha256: sealedHead.catalogTargetSha256,
        failureDomainSha256: sealedHead.failureDomainSha256,
        event,
      });
      validateTenantBackupCatalogAdapterEvent(mirrored.value);
      projectedCount += 1;
    }
    sequence = page.nextCatalogSequence;
    root = page.nextCatalogEventRootSha256;
    if (page.complete) break;
  }
  if (sequence !== sealedHead.catalogSequence || root !== sealedHead.catalogEventRootSha256) {
    throw cliError("catalog_corrupt");
  }
  return { eventCount, projectedCount };
}

function closeSafely(resource: { close(): Promise<void> } | undefined): Promise<void> | undefined {
  return resource === undefined
    ? undefined
    : Promise.resolve().then(() => resource.close());
}

export async function runBackupCatalogCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: BackupCatalogCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const command = parseCommand(argv);
  const mysql = MysqlEnv.parse(env);
  const pageSize = (command === "list" || command === "reconcile")
    ? parsePageSize(env)
    : DEFAULT_PAGE_SIZE;

  if (command === "activate") ActivateEnv.parse(env);
  else if (command === "begin-backup") BeginBackupEnv.parse(env);
  else if (command === "publish-backup") PublishEnv.parse(env);
  else if (command === "prepare-restore") PrepareRestoreEnv.parse(env);
  else if (command === "resolve-restore") ResolveRestoreEnv.parse(env);
  else if (command === "prepare-eviction") EvictionEnv.parse(env);
  else if (command === "record-eviction") RecordEvictionEnv.parse(env);

  const adapterCommand = command !== "list"
    && (command !== "status" || env.BACKUP_CATALOG_ADAPTER !== undefined);
  const catalogConfig = adapterCommand
    ? loadCatalogRuntimeConfig(env, dependencies, command === "activate")
    : undefined;
  const prepareSettings = command === "prepare-restore" ? PrepareRestoreEnv.parse(env) : undefined;
  const journalConfig = prepareSettings === undefined
    ? undefined
    : loadRestoreRuntimeConfig(env, prepareSettings.BACKUP_RUNTIME_EPOCH_ID, dependencies);
  if (catalogConfig && journalConfig
    && catalogConfig.logicalDatabaseNamespaceSha256
      !== journalConfig.logicalDatabaseNamespaceSha256) {
    throw cliError("invalid_configuration");
  }
  const catalogAdapter = catalogConfig === undefined
    ? undefined
    : dependencies.createCatalogAdapter(catalogConfig);
  const journalAdapters = journalConfig === undefined
    ? []
    : Object.freeze([...dependencies.createJournalAdapters(journalConfig)]);

  let store: BackupCatalogCliStore | undefined;
  let summary: string | undefined;
  let operationError: unknown;
  try {
    if (catalogAdapter) await catalogAdapter.validateStartup();
    for (const adapter of journalAdapters) await adapter.validateStartup();
    store = await dependencies.connectStore({
      url: mysql.MYSQL_URL,
      connectionLimit: command === "status" || command === "list" ? 1 : 2,
      migrationMode: "verify",
    });
    const control = await store.getTenantBackupCatalogControl();
    validateTenantBackupCatalogControlRecord(control);

    if (command === "status") {
      const externalHead = catalogAdapter === undefined
        ? undefined
        : await catalogAdapter.readHead();
      if (externalHead && catalogConfig) assertHeadIdentity(externalHead, catalogConfig);
      summary = JSON.stringify({
        status: "ok",
        command,
        catalogState: control.state,
        catalogControlGeneration: control.controlGeneration,
        recoverableBackupCount: await countRecoverable(store),
        externalCatalogSequence: externalHead?.catalogSequence ?? null,
        externalCatalogEventRootSha256: externalHead?.catalogEventRootSha256 ?? null,
      });
    } else if (command === "activate") {
      const config = catalogConfig!;
      const adapter = catalogAdapter!;
      const head = await adapter.readHead();
      assertHeadIdentity(head, config);
      if (head.catalogSequence !== 0
        || head.catalogEventRootSha256 !== EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256) {
        throw cliError("catalog_conflict");
      }
      const journal = await store.getTenantRestoreJournalControl();
      const runtime = await store.getTenantRestoreRuntimeControl();
      const blob = await store.getBlobStorageControl();
      validateTenantRestoreJournalControlRecord(journal);
      validateTenantRestoreRuntimeControlRecord(runtime);
      validateBlobStorageControlRecord(blob);
      if (journal.controlGeneration !== 1
        || runtime.state !== "active"
        || blob.controlGeneration !== 1
        || journal.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256
        || runtime.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256
        || runtime.controlEvidenceSha256 !== journal.evidenceSha256
        || config.retentionPolicySha256 === undefined
        || config.minimumRetentionMs === undefined
        || config.minimumRecoverableBackups === undefined) {
        throw cliError("catalog_not_ready");
      }
      const activated = await store.activateTenantBackupCatalogControl({
        expectedControlGeneration: 0,
        adapterProtocol: config.adapterProtocol,
        catalogNamespaceSha256: config.catalogNamespaceSha256,
        catalogTargetSha256: config.catalogTargetSha256,
        failureDomainSha256: config.failureDomainSha256,
        logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
        journalControlEvidenceSha256: journal.evidenceSha256,
        retentionPolicySha256: config.retentionPolicySha256,
        minimumRetentionMs: config.minimumRetentionMs,
        minimumRecoverableBackups: config.minimumRecoverableBackups,
      });
      summary = JSON.stringify({
        status: "ok",
        command,
        disposition: activated.disposition,
        catalogControlGeneration: activated.value.controlGeneration,
        catalogControlEvidenceSha256: activated.value.evidenceSha256,
      });
    } else if (command === "begin-backup") {
      const settings = BeginBackupEnv.parse(env);
      assertCatalogIdentity(control, catalogConfig!);
      await reconcileExternalChain(store, catalogAdapter!, pageSize);
      const anchored = await store.createTenantBackupSnapshotAnchor({
        backupId: settings.BACKUP_ID,
        controlEvidenceSha256: control.evidenceSha256,
      });
      summary = JSON.stringify({
        status: "ok",
        command,
        disposition: anchored.disposition,
        backupId: anchored.value.backupId,
        anchorSha256: anchored.value.anchorSha256,
        retentionUntilDbMs: anchored.value.retentionUntilDbMs,
      });
    } else if (command === "publish-backup") {
      const settings = PublishEnv.parse(env);
      assertCatalogIdentity(control, catalogConfig!);
      const anchor = await store.getTenantBackupSnapshotAnchor(settings.BACKUP_ID);
      if (!anchor) throw cliError("invalid_durable_state");
      const published = await catalogAdapter!.publishAvailability({
        backupId: settings.BACKUP_ID,
        anchorSha256: anchor.anchorSha256,
        sourceSnapshotSha256: settings.SOURCE_SNAPSHOT_SHA256,
        sourceBackupSha256: settings.SOURCE_BACKUP_SHA256,
        artifactManifestSha256: settings.BACKUP_ARTIFACT_MANIFEST_SHA256,
        providerEvidenceSha256: settings.BACKUP_PROVIDER_EVIDENCE_SHA256,
        controlEvidenceSha256: control.evidenceSha256,
        logicalDatabaseNamespaceSha256: control.logicalDatabaseNamespaceSha256,
        retentionPolicySha256: control.retentionPolicySha256,
        retentionUntilDbMs: anchor.retentionUntilDbMs,
        registeredAtDbMs: anchor.createdAtDbMs,
      });
      const recorded = await store.recordTenantBackupCatalogAvailability(published);
      if (!exactAvailability(recorded.value, published)) {
        throw cliError("invalid_durable_state");
      }
      summary = JSON.stringify({
        status: "ok",
        command,
        disposition: recorded.disposition,
        backupId: recorded.value.backupId,
        entrySha256: recorded.value.entrySha256,
        catalogSequence: recorded.value.catalogSequence,
        catalogEventRootSha256: recorded.value.catalogEventRootSha256,
      });
    } else if (command === "list") {
      const afterBackupId = env.BACKUP_CATALOG_AFTER_BACKUP_ID;
      if (afterBackupId !== undefined && !BACKUP_ID.test(afterBackupId)) {
        throw cliError("invalid_configuration");
      }
      const entries = await store.listRecoverableTenantBackups({
        limit: pageSize,
        ...(afterBackupId === undefined ? {} : { afterBackupId }),
      });
      for (const entry of entries) validateTenantBackupCatalogEntry(entry);
      summary = JSON.stringify({
        status: "ok",
        command,
        count: entries.length,
        nextAfterBackupId: entries.length === pageSize ? entries.at(-1)!.backupId : null,
        backups: entries.map((entry) => ({
          backupId: entry.backupId,
          entrySha256: entry.entrySha256,
          sourceBackupSha256: entry.sourceBackupSha256,
          retentionUntilDbMs: entry.retentionUntilDbMs,
        })),
      });
    } else if (command === "prepare-restore") {
      const settings = prepareSettings!;
      const config = catalogConfig!;
      assertCatalogIdentity(control, config);
      const journal = await store.getTenantRestoreJournalControl();
      validateTenantRestoreJournalControlRecord(journal);
      if (journal.controlGeneration !== 1
        || journal.evidenceSha256 !== control.journalControlEvidenceSha256
        || journal.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256) {
        throw cliError("invalid_durable_state");
      }
      await reconcileExternalChain(store, catalogAdapter!, pageSize);
      const availability = await catalogAdapter!.inspectAvailability(settings.BACKUP_ID);
      if (!availability || availability.sourceBackupSha256 !== settings.SOURCE_BACKUP_SHA256) {
        throw cliError("catalog_conflict");
      }
      const runtimeEpochSha256 = tenantRestoreRuntimeEpochSha256(
        settings.BACKUP_RUNTIME_EPOCH_ID,
      );
      if (runtimeEpochSha256 !== journalConfig!.runtimeEpochSha256) {
        throw cliError("invalid_configuration");
      }
      const entry = await store.preflightTenantRestoreReplayFromBackup({
        backupId: settings.BACKUP_ID,
        restoreRunId: settings.RESTORE_RUN_ID,
        runtimeEpochSha256,
      });
      if (!exactAvailability(entry, availability)) {
        throw cliError("invalid_durable_state");
      }
      const sealedTargets = await readRestoreJournalHeads(journalConfig!, journalAdapters);
      const reserved = await catalogAdapter!.reserveRestore({
        backupId: settings.BACKUP_ID,
        restoreRunId: settings.RESTORE_RUN_ID,
        entrySha256: entry.entrySha256,
        runtimeEpochSha256,
      });
      const prepared = await store.prepareTenantRestoreReplayFromBackup({
        backupId: settings.BACKUP_ID,
        restoreRunId: settings.RESTORE_RUN_ID,
        runtimeEpochSha256,
        controlEvidenceSha256: control.journalControlEvidenceSha256,
        sealedTargets,
        reservation: reserved,
      });
      summary = JSON.stringify({
        status: "ok",
        command,
        disposition: prepared.disposition,
        backupId: prepared.value.binding.backupId,
        restoreRunId: prepared.value.replayRun.restoreRunId,
        restorePhase: prepared.value.replayRun.phase,
        runtimeEpochSha256: prepared.value.reservation.runtimeEpochSha256,
        reservationSha256: prepared.value.reservation.reservationSha256,
        catalogSequence: prepared.value.reservation.catalogSequence,
      });
    } else if (command === "resolve-restore") {
      const settings = ResolveRestoreEnv.parse(env);
      assertCatalogIdentity(control, catalogConfig!);
      const reservation = await store.getTenantBackupRuntimeReservation(settings.RESTORE_RUN_ID);
      const run = await store.getTenantRestoreReplayRun(settings.RESTORE_RUN_ID);
      if (!reservation || !run) throw cliError("invalid_durable_state");
      validateTenantBackupRuntimeReservation(reservation);
      validateTenantRestoreReplayRunRecord(run);
      const phase = run.phase === "active"
        ? "activated" as const
        : run.phase === "aborted" ? "aborted" as const : undefined;
      if (!phase) throw cliError("catalog_not_ready");
      const resolved = await catalogAdapter!.resolveRestore({
        restoreRunId: settings.RESTORE_RUN_ID,
        reservationReceiptSha256: reservation.reservationReceiptSha256,
        phase,
      });
      const projected = await store.resolveTenantBackupRuntimeReservation(resolved);
      summary = JSON.stringify({
        status: "ok",
        command,
        disposition: projected.disposition,
        restoreRunId: projected.value.restoreRunId,
        phase: projected.value.phase,
        reservationSha256: projected.value.reservationSha256,
        resolutionCatalogSequence: projected.value.phase === "reserved"
          ? null
          : projected.value.resolutionCatalogSequence,
      });
    } else if (command === "prepare-eviction" || command === "record-eviction") {
      const settings = command === "record-eviction"
        ? RecordEvictionEnv.parse(env)
        : EvictionEnv.parse(env);
      assertCatalogIdentity(control, catalogConfig!);
      const existingEviction = command === "record-eviction"
        ? await store.getTenantBackupCatalogEviction(settings.BACKUP_ID)
        : null;
      if (existingEviction && existingEviction.evictionId !== settings.BACKUP_EVICTION_ID) {
        throw cliError("catalog_conflict");
      }
      const plan = existingEviction
        ? evictionPlanFromRecord(existingEviction)
        : await store.prepareTenantBackupEviction({
            evictionId: settings.BACKUP_EVICTION_ID,
            backupId: settings.BACKUP_ID,
          });
      if (command === "prepare-eviction") {
        const head = await catalogAdapter!.readHead();
        assertHeadIdentity(head, catalogConfig!);
        if (head.catalogSequence !== plan.expectedCatalogSequence
          || head.catalogEventRootSha256 !== plan.expectedCatalogEventRootSha256) {
          throw cliError("catalog_conflict");
        }
        summary = JSON.stringify({
          status: "ok",
          command,
          evictionId: plan.evictionId,
          backupId: plan.backupId,
          planSha256: plan.planSha256,
          artifactManifestSha256: plan.artifactManifestSha256,
          providerEvidenceSha256: plan.providerEvidenceSha256,
          expectedCatalogSequence: plan.expectedCatalogSequence,
          expectedCatalogEventRootSha256: plan.expectedCatalogEventRootSha256,
        });
      } else {
        const record = settings as z.infer<typeof RecordEvictionEnv>;
        const acknowledged = await catalogAdapter!.recordEviction({
          plan,
          externalTombstoneSha256: record.EXTERNAL_TOMBSTONE_SHA256,
          observedAbsent: true,
        });
        const evicted = await store.recordTenantBackupCatalogEviction({
          plan,
          acknowledgement: acknowledged,
        });
        summary = JSON.stringify({
          status: "ok",
          command,
          disposition: evicted.disposition,
          evictionId: evicted.value.evictionId,
          backupId: evicted.value.backupId,
          evictionSha256: evicted.value.evictionSha256,
          catalogSequence: evicted.value.catalogSequence,
        });
      }
    } else {
      assertCatalogIdentity(control, catalogConfig!);
      const result = await reconcileExternalChain(store, catalogAdapter!, pageSize);
      summary = JSON.stringify({ status: "ok", command, ...result });
    }
  } catch (error) {
    operationError = error;
  }

  const closeResults = await Promise.allSettled([
    closeSafely(store),
    closeSafely(catalogAdapter),
    ...journalAdapters.map((adapter) => closeSafely(adapter)),
  ].filter((operation): operation is Promise<void> => operation !== undefined));
  if (operationError !== undefined) throw operationError;
  if (closeResults.some((result) => result.status === "rejected") || summary === undefined) {
    throw cliError("operation_failed");
  }
  dependencies.writeLine(summary);
  return 0;
}

function errorCode(error: unknown): BackupCatalogCliErrorCode {
  if (error instanceof BackupCatalogCliError) return error.code;
  if (error instanceof z.ZodError) return "invalid_configuration";
  if (error instanceof TenantBackupCatalogAdapterConflictError
    || error instanceof TenantBackupCatalogConflictError) return "catalog_conflict";
  if (error instanceof TenantBackupCatalogAdapterCorruptError
    || error instanceof TenantBackupCatalogIntegrityError) return "catalog_corrupt";
  if (error instanceof TenantBackupCatalogNotReadyError) return "catalog_not_ready";
  if (error instanceof TenantRestoreJournalConflictError) return "journal_conflict";
  if (error instanceof TenantRestoreJournalCorruptError) return "catalog_corrupt";
  return "operation_failed";
}

/** Fixed, content-free output; never stringify dependency errors, locators, or environment. */
export function formatBackupCatalogCliError(error: unknown): string {
  return JSON.stringify({ status: "error", code: errorCode(error) });
}
