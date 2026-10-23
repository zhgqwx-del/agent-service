import { isAbsolute } from "node:path";
import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  MysqlSessionStore,
  captureSessionAuthorityBindingCommand,
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
  validateTenantTelemetryCaptureEpochCutoverReceipt,
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
  type TenantRestoreReplayRunRecord,
  type TenantTelemetryCaptureBackupCheckpointStore,
  type TenantTelemetryCaptureRestoreMaintenance,
  type MysqlTenantTelemetryCaptureRestoreMaintenanceOptions,
  type MysqlTenantTelemetryCaptureArtifactRestoreMaintenanceOptions,
  type TenantTelemetryCaptureBackupSourceMaintenance,
  type MysqlTenantTelemetryCaptureBackupSourceMaintenanceOptions,
  type MysqlRestoreJournalMaintenanceProfile,
  type SchemaMetadataReaderConfig,
  type SessionAuthorityBindingOperatorContext,
} from "@agent-service/store";
import { z } from "zod";
import { canonicalJson, sha256 } from "./mysql-backup-artifact-codec.js";
import { loadMysqlSchemaRuntimeConfig } from "./mysql-schema-config.js";
import { loadSessionAuthorityOperatorContext, parseSessionAuthorityOperatorConfiguration } from "./session-authority-operator-config.js";
import * as mysqlArtifact from "./mysql-backup-artifact.js";
import { createMySqlBackupArtifactSourceObserver, type MySqlBackupArtifactSourceObserver } from "./mysql-backup-artifact-source-observer.js";
import { SelectedRestoreError, readSelectedRestoreCatalog, readSelectedRestoreContext,
  replaySelectedRestore, verifySelectedRestore, activateSelectedRestore,
  readActivatedSelectedRestore, assertSelectedRestoreFreshHeads, resolveSelectedRestore } from "./backup-selected-restore.js";
import { readTelemetryCaptureRefKey, tenantTelemetryOperatorRefKeyPath } from "./telemetry-capture-ref-key.js";
import {
  createTenantBackupCatalogAdapter,
  loadTenantBackupCatalogConfig,
  type TenantBackupCatalogRuntimeConfig,
} from "./tenant-backup-catalog-config.js";
import {
  createTenantRestoreJournalAdapters,
  loadTenantRestoreJournalConfig,
  loadTenantRestoreJournalSourceObservationConfig,
  createTenantRestoreJournalSourceObservationAdapters,
  type TenantRestoreJournalRuntimeConfig,
} from "./tenant-restore-journal-config.js";

const COMMANDS = [
  "status",
  "activate",
  "begin-backup",
  "publish-backup",
  "create-artifact",
  "verify-artifact",
  "restore-selected",
  "replay-selected",
  "verify-selected",
  "activate-selected",
  "activate-capture-selected",
  "resolve-selected",
  "list",
  "prepare-restore",
  "resolve-restore",
  "prepare-eviction",
  "record-eviction",
  "reconcile",
] as const;
type BackupCatalogCommand = (typeof COMMANDS)[number];
const SELECTED_COMMANDS = ["replay-selected", "verify-selected", "activate-selected", "activate-capture-selected", "resolve-selected"] as const;
type SelectedArtifactCommand = typeof SELECTED_COMMANDS[number];

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
  | "runtime_head_changed"
  | "operation_deadline"
  | "operation_failed";

class BackupCatalogCliError extends Error {
  constructor(
    readonly code: BackupCatalogCliErrorCode,
    readonly restoreBoundary?: { reservationMayBeConsumed: true; targetMayContainPartialImport: boolean },
    readonly selectedBoundary?: { restoreMutationMayBeCommitted: true; runtimeActivationMayBeCommitted: boolean;
      captureActivationMayBeCommitted: boolean; catalogResolutionMayBeCommitted?: true },
  ) {
    super(code);
    this.name = "BackupCatalogCliError";
  }
}

type BackupCatalogCliStore = TenantBackupCatalogStore
  & TenantTelemetryCaptureBackupCheckpointStore
  & TenantRestoreJournalStore
  & RestoreReplayStore
  & BlobStorageControlStore
  & { close(): Promise<void> };

/** The 0031 prepare orchestration needs only these capabilities. A real stopped source
 * facade and an ordinary catalog Store both satisfy it; neither is cast into the other role. */
type PrepareRestorePort = Pick<TenantBackupCatalogStore,
  "getTenantBackupCatalogControl" | "mirrorTenantBackupCatalogEvent"
  | "preflightTenantRestoreReplayFromBackup" | "prepareTenantRestoreReplayFromBackup">
  & Pick<TenantRestoreJournalStore, "getTenantRestoreJournalControl">;

const STOPPED_LOCAL_PREPARE_ACK = "BACKUP_CATALOG_PREPARE_RESTORE_STOPPED_LOCAL_ACK";

function stoppedLocalPrepareRequested(command: string, env: NodeJS.ProcessEnv): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(env, STOPPED_LOCAL_PREPARE_ACK);
  if (descriptor === undefined) return false;
  if (command !== "prepare-restore" || !descriptor.enumerable || !("value" in descriptor)
    || descriptor.value !== "1" || env.RESTORE_FLEET_STOPPED_ACK !== "1"
    || env.NODE_ENV === "production" || process.env.NODE_ENV === "production") {
    throw cliError("invalid_configuration");
  }
  return true;
}

type RestoreAdapter = TenantRestoreJournalAdapter & {
  validateStartup(): Promise<void>;
};

export interface BackupCatalogCliDependencies {
  connectStore(options: {
    url: string;
    connectionLimit: number;
    migrationMode: "verify";
    tenantTelemetryRefKey?: Uint8Array;
    tenantTelemetryCaptureRestoreLocalOnly?: boolean;
    operationAbortSignal?: AbortSignal;
    schemaMetadata?: SchemaMetadataReaderConfig;
  }): Promise<BackupCatalogCliStore>;
  connectCaptureRestoreMaintenance?(
    options: MysqlTenantTelemetryCaptureRestoreMaintenanceOptions,
    profile: MysqlRestoreJournalMaintenanceProfile,
  ): Promise<TenantTelemetryCaptureRestoreMaintenance>;
  connectCaptureArtifactRestoreMaintenance?(
    options: MysqlTenantTelemetryCaptureArtifactRestoreMaintenanceOptions,
    profile: MysqlRestoreJournalMaintenanceProfile,
  ): Promise<TenantTelemetryCaptureRestoreMaintenance>;
  connectCaptureBackupSourceMaintenance?(
    options: MysqlTenantTelemetryCaptureBackupSourceMaintenanceOptions,
    profile: Extract<MysqlRestoreJournalMaintenanceProfile, { kind: "stopped-fleet-maintenance" }>,
  ): Promise<TenantTelemetryCaptureBackupSourceMaintenance>;
  loadCatalogConfig(
    env: NodeJS.ProcessEnv,
    context: Parameters<typeof loadTenantBackupCatalogConfig>[1],
  ): TenantBackupCatalogRuntimeConfig | undefined;
  createCatalogAdapter(config: TenantBackupCatalogRuntimeConfig, options?: {
    operationAbortSignal?: AbortSignal;
  }): TenantBackupCatalogAdapter;
  loadJournalConfig(
    env: NodeJS.ProcessEnv,
    context: Parameters<typeof loadTenantRestoreJournalConfig>[1],
  ): TenantRestoreJournalRuntimeConfig | undefined;
  createJournalAdapters(config: TenantRestoreJournalRuntimeConfig, options?: {
    operationAbortSignal?: AbortSignal;
  }): readonly RestoreAdapter[];
  writeLine(line: string): void;
  /** Test clock only; production uses a monotonic clock for the entire operation. */
  now?: () => number;
  artifactOperations?: Pick<typeof mysqlArtifact,
    "acquireMySqlBackupArtifactOperator" | "createMySqlBackupArtifact"
    | "verifyMySqlBackupArtifact" | "importVerifiedMySqlBackupArtifact">;
  readRefKey?: (path: string) => Promise<Buffer>;
  loadAuthorityContext?: typeof loadSessionAuthorityOperatorContext;
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

const ArtifactEnv = BackupEnv.extend({
  BACKUP_ARTIFACT_LOCAL_ONLY_ACK: z.literal("1"),
  BACKUP_ARTIFACT_DIRECTORY: z.string().min(1).max(4_096).refine(isAbsolute),
  BACKUP_ARTIFACT_KEY_FILE: z.string().min(1).max(4_096).refine(isAbsolute),
});
const ArtifactToolsEnv = z.object({
  BACKUP_MYSQL_BINARY: z.string().min(1).max(4_096).refine(isAbsolute),
  BACKUP_MYSQLDUMP_BINARY: z.string().min(1).max(4_096).refine(isAbsolute),
});
const CreateArtifactEnv = ArtifactEnv.extend({ RESTORE_FLEET_STOPPED_ACK: z.literal("1") });
const RestoreSelectedEnv = CreateArtifactEnv.extend({
  RESTORE_RUN_ID: z.string().regex(RESTORE_RUN_ID),
  BACKUP_RUNTIME_EPOCH_ID: z.string().regex(SAFE_ID),
  BACKUP_RESTORE_TARGET_MYSQL_URL: MysqlEnv.shape.MYSQL_URL,
});
const SelectedContinuationEnv = CreateArtifactEnv.extend({
  RESTORE_RUN_ID: z.string().regex(RESTORE_RUN_ID),
  BACKUP_RUNTIME_EPOCH_ID: z.string().regex(SAFE_ID),
  BACKUP_RESTORE_TARGET_MYSQL_URL: MysqlEnv.shape.MYSQL_URL,
});
const SelectedCaptureAcks = z.object({
  TELEMETRY_CAPTURE_RESTORED_EPOCH_ACTIVATION_ACK: z.literal("1"),
  TELEMETRY_CAPTURE_LOCAL_ONLY_ACK: z.literal("1"),
  TELEMETRY_CAPTURE_FLEET_STOPPED_ACK: z.literal("1"),
  TELEMETRY_CAPTURE_LEGACY_WRITERS_DRAINED_ACK: z.literal("1"),
  TELEMETRY_CAPTURE_PRODUCER_READY_ACK: z.literal("1"),
  TELEMETRY_CAPTURE_CONFIGURED_FLEET_ROOT_SHA256: z.string().regex(SHA256),
});

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw cliError("invalid_configuration");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > maximum) throw cliError("invalid_configuration");
  return result;
}

function artifactBudget(env: NodeJS.ProcessEnv, dependencies: BackupCatalogCliDependencies, authorityTimeoutMs?: number) {
  const maxBytes = boundedInteger(env.BACKUP_ARTIFACT_MAX_BYTES, 256 * 1_024 * 1_024, 1_024 * 1_024 * 1_024);
  const configuredTimeoutMs = boundedInteger(env.BACKUP_ARTIFACT_DEADLINE_MS, 120_000, 600_000);
  const timeoutMs = authorityTimeoutMs === undefined ? configuredTimeoutMs : Math.min(configuredTimeoutMs, authorityTimeoutMs);
  const now = dependencies.now ?? (() => performance.now());
  const expiresAt = now() + timeoutMs;
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const remaining = () => {
    const value = Math.floor(expiresAt - now());
    if (value <= 0 || controller.signal.aborted) {
      controller.abort();
      throw cliError("operation_deadline");
    }
    return value;
  };
  const run = async <T>(operation: () => Promise<T>, lateDispose?: (value: T) => Promise<void>): Promise<T> => {
    const left = remaining();
    // Keep one live deadline handle even if a custom dependency leaves only an
    // unresolved promise. Arm lazily so synchronous configuration failures leak no timer.
    deadlineTimer ??= setTimeout(() => controller.abort(), left);
    let abandoned = false;
    let removeAbortListener = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      const onAbort = () => { abandoned = true; reject(cliError("operation_deadline")); };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    });
    const task = track(Promise.resolve().then(() => { remaining(); return operation(); }).then(async (value) => {
      if (abandoned && lateDispose) await lateDispose(value);
      return value;
    }));
    try {
      const result = await Promise.race([task, interrupted]);
      try { remaining(); } catch (error) {
        if (lateDispose) {
          // The operation has already settled, so this disposal is not part of
          // task. Keep it in the same settlement barrier as all native closes.
          const disposal = track(Promise.resolve().then(() => lateDispose(result)));
          await boundedCleanup(() => disposal);
        }
        throw error;
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw cliError("operation_deadline");
      throw error;
    } finally { removeAbortListener(); }
  };
  return { maxBytes, remaining, run, signal: controller.signal,
    check: () => { remaining(); },
    assertBeforeDeadline: () => { if (now() >= expiresAt) throw cliError("operation_deadline"); },
    abort: () => { if (deadlineTimer) clearTimeout(deadlineTimer); controller.abort(); },
    trackCleanup: (operation: () => Promise<void>) => track(Promise.resolve().then(operation)),
    settled: () => Promise.allSettled([...pending]),
  };
}
type AsyncStep = <T>(operation: () => Promise<T>) => Promise<T>;
const unlimitedStep: AsyncStep = (operation) => operation();
/** Only the foreground wait is bounded; ownership remains with the real cleanup promise. */
async function boundedCleanup(operation: () => Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(() => true, () => false),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 250); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
/** Settlement is a resource barrier, not a first-rejection race. A rejected
 * close remains a failure, not proof of transport cancellation, and cannot
 * hide another close that is still live. */
async function closeAllSettled(resources: readonly ({ close(): Promise<void> } | undefined)[]): Promise<void> {
  const results = await Promise.allSettled(resources.map((resource) => closeSafely(resource)));
  if (results.some((result) => result.status === "rejected")) throw cliError("operation_failed");
}
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
  connectCaptureRestoreMaintenance: (options, profile) => MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance(options, profile),
  connectCaptureArtifactRestoreMaintenance: (options, profile) => MysqlSessionStore.connectTenantTelemetryCaptureArtifactRestoreMaintenance(options, profile),
  connectCaptureBackupSourceMaintenance: (options, profile) => MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance(options, profile),
  loadCatalogConfig: (env, context) => loadTenantBackupCatalogConfig(env, context),
  createCatalogAdapter: (config, options) => createTenantBackupCatalogAdapter(config, options),
  loadJournalConfig: (env, context) => loadTenantRestoreJournalConfig(env, context),
  createJournalAdapters: (config, options) => createTenantRestoreJournalAdapters(config, options),
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
  step: AsyncStep = unlimitedStep,
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
    const head = await step(() => adapter.readHead());
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
  store: Pick<TenantBackupCatalogStore, "mirrorTenantBackupCatalogEvent">,
  adapter: TenantBackupCatalogAdapter,
  pageSize: number,
  step: AsyncStep = unlimitedStep,
  selectedBackupId?: string,
  firstRestore?: { restoreRunId: string; runtimeEpochSha256: string },
): Promise<{ eventCount: number; projectedCount: number }> {
  const sealedHead = await step(() => adapter.readHead());
  validateTenantBackupCatalogHead(sealedHead);
  let sequence = 0;
  let root = EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256;
  let eventCount = 0;
  let projectedCount = 0;
  while (sequence < sealedHead.catalogSequence) {
    const page = await step(() => adapter.scanEvents({
      afterCatalogSequence: sequence,
      afterCatalogEventRootSha256: root,
      sealedHead,
      limit: pageSize,
    }));
    if (page.events.length === 0 && !page.complete) throw cliError("catalog_corrupt");
    for (const event of page.events) {
      validateTenantBackupCatalogAdapterEvent(event);
      // inspectAvailability intentionally retains historical availability after eviction.
      // A fresh sealed-chain read, not that historical row, decides recoverability.
      if (selectedBackupId !== undefined && event.eventType === "backup_evicted"
        && event.result.backupId === selectedBackupId) throw cliError("catalog_conflict");
      // Permanent authority survives local-directory changes and resolution/abort.
      // This command never resumes an old import; only its own second prepare may replay.
      if (firstRestore && event.eventType === "restore_reserved"
        && (event.result.restoreRunId === firstRestore.restoreRunId
          || event.result.runtimeEpochSha256 === firstRestore.runtimeEpochSha256)) {
        throw cliError("catalog_conflict");
      }
      eventCount += 1;
      const mirrored = await step(() => store.mirrorTenantBackupCatalogEvent({
        adapterProtocol: sealedHead.adapterProtocol,
        catalogNamespaceSha256: sealedHead.catalogNamespaceSha256,
        catalogTargetSha256: sealedHead.catalogTargetSha256,
        failureDomainSha256: sealedHead.failureDomainSha256,
        event,
      }));
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

/** Shared 0031 orchestration; selected artifacts supply bytes-derived evidence, never argv evidence. */
async function prepareSelectedRestore(
  store: PrepareRestorePort,
  adapter: TenantBackupCatalogAdapter,
  config: TenantBackupCatalogRuntimeConfig,
  journalConfig: TenantRestoreJournalRuntimeConfig,
  journalAdapters: readonly RestoreAdapter[],
  settings: { backupId: string; restoreRunId: string; epochId: string; sourceBackupSha256: string; captureCheckpointSha256?: string },
  step: AsyncStep = unlimitedStep,
) {
  const control = await step(() => store.getTenantBackupCatalogControl());
  assertCatalogIdentity(control, config);
  const journal = await step(() => store.getTenantRestoreJournalControl());
  validateTenantRestoreJournalControlRecord(journal);
  if (journal.controlGeneration !== 1
    || journal.evidenceSha256 !== control.journalControlEvidenceSha256
    || journal.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256) {
    throw cliError("invalid_durable_state");
  }
  await reconcileExternalChain(store, adapter, DEFAULT_PAGE_SIZE, step);
  const availability = await step(() => adapter.inspectAvailability(settings.backupId));
  if (!availability || availability.sourceBackupSha256 !== settings.sourceBackupSha256) {
    throw cliError("catalog_conflict");
  }
  const runtimeEpochSha256 = tenantRestoreRuntimeEpochSha256(settings.epochId);
  if (runtimeEpochSha256 !== journalConfig.runtimeEpochSha256) {
    throw cliError("invalid_configuration");
  }
  const entry = await step(() => store.preflightTenantRestoreReplayFromBackup({
    backupId: settings.backupId,
    restoreRunId: settings.restoreRunId,
    runtimeEpochSha256,
    ...(settings.captureCheckpointSha256 === undefined ? {} : { captureCheckpointSha256: settings.captureCheckpointSha256 }),
  }));
  if (!exactAvailability(entry, availability)) throw cliError("invalid_durable_state");
  const sealedTargets = await readRestoreJournalHeads(journalConfig, journalAdapters, step);
  const reserved = await step(() => adapter.reserveRestore({
    backupId: settings.backupId,
    restoreRunId: settings.restoreRunId,
    entrySha256: entry.entrySha256,
    runtimeEpochSha256,
  }));
  const prepared = await step(() => store.prepareTenantRestoreReplayFromBackup({
    backupId: settings.backupId,
    restoreRunId: settings.restoreRunId,
    runtimeEpochSha256,
    controlEvidenceSha256: control.journalControlEvidenceSha256,
    sealedTargets,
    reservation: reserved,
    ...(settings.captureCheckpointSha256 === undefined ? {} : { captureCheckpointSha256: settings.captureCheckpointSha256 }),
  }));
  return prepared;
}

async function runArtifactCommand(
  command: "create-artifact" | "verify-artifact" | "restore-selected",
  env: NodeJS.ProcessEnv,
  dependencies: BackupCatalogCliDependencies,
  refKeyPath: string | undefined,
): Promise<number> {
  // This is a restricted local vertical slice, not a production backup/DR operator.
  if (env.NODE_ENV === "production") throw cliError("invalid_configuration");
  if (Reflect.ownKeys(env).some(key => typeof key === "string" && key.startsWith("AUTHORITY_"))) {
    throw cliError("invalid_configuration");
  }
  const mysql = MysqlEnv.parse(env);
  const settings = ArtifactEnv.parse(env);
  const restore = command === "restore-selected" ? RestoreSelectedEnv.parse(env) : undefined;
  CreateArtifactEnv.parse(env);
  const stoppedProfile = Object.freeze({ kind: "stopped-fleet-maintenance" as const,
    fleetStoppedAck: "fleet-stopped-v1" as const, localOnlyAck: "local-only-v1" as const });
  if (!dependencies.connectCaptureBackupSourceMaintenance) throw cliError("invalid_configuration");
  const tools = command === "verify-artifact" ? undefined : ArtifactToolsEnv.parse(env);
  const budget = artifactBudget(env, dependencies);
  const config = loadCatalogRuntimeConfig(env, dependencies, false);
  const journalConfig = restore === undefined ? undefined
    : loadRestoreRuntimeConfig(env, restore.BACKUP_RUNTIME_EPOCH_ID, dependencies);
  if (journalConfig && journalConfig.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256) {
    throw cliError("invalid_configuration");
  }
  budget.check();
  const operations = dependencies.artifactOperations ?? mysqlArtifact;
  const common = {
    artifactDirectory: settings.BACKUP_ARTIFACT_DIRECTORY,
    keyFile: settings.BACKUP_ARTIFACT_KEY_FILE,
    localOnlyAck: true as const,
    maxBytes: budget.maxBytes,
    operationAbortSignal: budget.signal,
    ...(env.NODE_ENV === undefined ? {} : { nodeEnv: env.NODE_ENV }),
  };
  const binaries = tools === undefined ? undefined : {
    mysql: tools.BACKUP_MYSQL_BINARY, mysqldump: tools.BACKUP_MYSQLDUMP_BINARY,
  };
  let store: TenantTelemetryCaptureBackupSourceMaintenance | undefined;
  let adapterResource: TenantBackupCatalogAdapter | undefined;
  let journalResources: readonly RestoreAdapter[] = [];
  let sourceJournalResources: readonly RestoreAdapter[] = [];
  let targetStore: TenantTelemetryCaptureBackupSourceMaintenance | undefined;
  let targetMaintenance: TenantTelemetryCaptureRestoreMaintenance | undefined;
  let operator: Awaited<ReturnType<typeof operations.acquireMySqlBackupArtifactOperator>> | undefined;
  let verified: Awaited<ReturnType<typeof operations.verifyMySqlBackupArtifact>> | undefined;
  let summary: string | undefined;
  let operationError: unknown;
  let reservationAttempted = false;
  let importAttempted = false;
  let refKey: Buffer | undefined;
  const artifactOptions = () => ({ ...common, ...(refKey === undefined ? {} : { tenantTelemetryRefKey: refKey }) });
  const step: AsyncStep = async (operation) => {
    if (operator) await budget.run(() => operator!.assertHeld());
    const result = await budget.run(operation);
    if (operator) await budget.run(() => operator!.assertHeld());
    return result;
  };
  const acquire = <T extends { close(): Promise<void> }>(operation: () => Promise<T>) =>
    budget.run(operation, (resource) => resource.close());
  const connectArtifactStore = (url: string): Promise<TenantTelemetryCaptureBackupSourceMaintenance> => {
    // Both protected capture and genuinely inactive v1 sources use the private
    // stopped-fleet facade. The store validates a no-key NULL projection; no
    // arbitrary key or high-privilege ordinary SessionStore is substituted.
    return dependencies.connectCaptureBackupSourceMaintenance!({ url, connectionLimit: 2,
      ...(refKey === undefined ? {} : { tenantTelemetryRefKey: refKey }), operationAbortSignal: budget.signal,
      fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" }, stoppedProfile);
  };
  const withRestoreBoundary = (error: unknown): unknown => reservationAttempted
    ? new BackupCatalogCliError(errorCode(error), {
      reservationMayBeConsumed: true, targetMayContainPartialImport: importAttempted,
    })
    : error;
  try {
    if (refKeyPath !== undefined) {
      try {
        refKey = await budget.run(() => (dependencies.readRefKey ?? readTelemetryCaptureRefKey)(refKeyPath),
          async (lateKey) => { lateKey.fill(0); });
        if (!(refKey instanceof Uint8Array) || refKey.length !== 32) throw cliError("invalid_configuration");
      } catch (error) {
        if (error instanceof BackupCatalogCliError) throw error;
        throw cliError("invalid_configuration");
      }
    }
    if (refKey !== undefined && !dependencies.connectCaptureBackupSourceMaintenance) throw cliError("invalid_configuration");
    const adapter = dependencies.createCatalogAdapter(config, { operationAbortSignal: budget.signal });
    adapterResource = adapter;
    const journalAdapters = journalConfig === undefined ? []
      : Object.freeze([...dependencies.createJournalAdapters(journalConfig, { operationAbortSignal: budget.signal })]);
    journalResources = journalAdapters;
    await step(() => adapter.validateStartup());
    for (const journalAdapter of journalAdapters) await step(() => journalAdapter.validateStartup());
    if (command === "create-artifact") {
      operator = await acquire(() => operations.acquireMySqlBackupArtifactOperator({
        sourceUrl: mysql.MYSQL_URL,
        artifactDirectory: common.artifactDirectory,
        localOnlyAck: true, fleetStoppedAck: true,
        deadlineMs: budget.remaining(),
        operationAbortSignal: budget.signal,
        ...(refKey === undefined ? {} : { tenantTelemetryRefKey: refKey }),
        ...(common.nodeEnv === undefined ? {} : { nodeEnv: common.nodeEnv }),
      }));
    }
    store = await acquire(() => connectArtifactStore(mysql.MYSQL_URL));
    const source = store!;
    if (operator) await step(() => operator!.assertStoreBinding(source, "source"));
    const control = await step(() => source.getTenantBackupCatalogControl());
    assertCatalogIdentity(control, config);
    await reconcileExternalChain(source, adapter, DEFAULT_PAGE_SIZE, step, settings.BACKUP_ID);

    if (command === "create-artifact") {
      const anchored = await step(() => source.createTenantBackupSnapshotAnchor({
        backupId: settings.BACKUP_ID, controlEvidenceSha256: control.evidenceSha256,
      }));
      let sourceObserver: MySqlBackupArtifactSourceObserver | undefined;
      if (refKey !== undefined) {
        const runtime = await step(() => source.getTenantRestoreRuntimeControl());
        validateTenantRestoreRuntimeControlRecord(runtime);
        if (runtime.state === "active" && runtime.lineageKind === "restore") {
          const observation = loadTenantRestoreJournalSourceObservationConfig(env, { production: false, store: "mysql",
            ...(env.BLOB_STORE === "s3" && env.BLOB_S3_BUCKET !== undefined ? { blobS3Bucket: env.BLOB_S3_BUCKET } : {}) }, runtime.runtimeEpochSha256);
          if (!observation) throw cliError("invalid_configuration");
          const journals = createTenantRestoreJournalSourceObservationAdapters(observation, { operationAbortSignal: budget.signal, ownedNativeTransport: true });
          sourceJournalResources = Object.freeze([...journals]);
          // No startup probe/read-head occurs here. The opaque observer is
          // invoked ONLY by the producer's new-dump branch, not exact replay.
          sourceObserver = createMySqlBackupArtifactSourceObserver({ store: source, config: observation,
            catalog: adapter, journals, step });
        }
      }
      const created = await step(() => operations.createMySqlBackupArtifact({
        ...artifactOptions(), sourceUrl: mysql.MYSQL_URL, anchor: anchored.value, tools: binaries!,
        captureCheckpointStore: source,
        ...(sourceObserver === undefined ? {} : { sourceObserver }),
        fleetStoppedAck: true, deadlineMs: budget.remaining(), operator: operator!,
      }));
      verified = await acquire(() => operations.verifyMySqlBackupArtifact({
        ...artifactOptions(), backupId: settings.BACKUP_ID, expectedAnchor: anchored.value,
        expectedEvidence: created.evidence, deadlineMs: budget.remaining(),
      }));
      // Only new bytes need a current-source publication gate. Exact replay
      // already verified historical actual bytes/checkpoint in the producer;
      // its own prior availability event legitimately advanced catalog head.
      if (created.disposition !== "exact_replay") {
        const captureInput = { backupId: settings.BACKUP_ID, fleetStoppedAck: "fleet-stopped-v1" as const,
          localOnlyAck: "local-only-v1" as const };
        if (verified.manifest.version !== 1) {
          const checkpointSha256 = verified.manifest.captureCheckpoint.checkpointSha256;
          await step(() => source.assertTenantTelemetryCaptureBackupCheckpointUnchanged({ ...captureInput,
            checkpointSha256 }));
        } else if (await step(() => source.sealTenantTelemetryCaptureBackupCheckpoint(captureInput)) !== null) {
          throw cliError("invalid_durable_state");
        }
      }
      const published = await step(() => adapter.publishAvailability({
        backupId: settings.BACKUP_ID, anchorSha256: anchored.value.anchorSha256,
        ...verified!.evidence, controlEvidenceSha256: control.evidenceSha256,
        logicalDatabaseNamespaceSha256: control.logicalDatabaseNamespaceSha256,
        retentionPolicySha256: control.retentionPolicySha256,
        retentionUntilDbMs: anchored.value.retentionUntilDbMs,
        registeredAtDbMs: anchored.value.createdAtDbMs,
      }));
      const recorded = await step(() => source.recordTenantBackupCatalogAvailability(published));
      if (!exactAvailability(recorded.value, published)) throw cliError("invalid_durable_state");
      summary = JSON.stringify({
        status: "ok", command, disposition: created.disposition, backupId: settings.BACKUP_ID,
        artifactVerified: true, ...verified!.evidence, entrySha256: recorded.value.entrySha256,
        catalogSequence: recorded.value.catalogSequence,
      });
    } else {
      const availability = await step(() => adapter.inspectAvailability(settings.BACKUP_ID));
      const entry = await step(() => source.getTenantBackupCatalogEntry(settings.BACKUP_ID));
      const anchor = await step(() => source.getTenantBackupSnapshotAnchor(settings.BACKUP_ID));
      if (!availability || !entry || !anchor || !exactAvailability(entry, availability)
        || anchor.anchorSha256 !== entry.anchorSha256) throw cliError("catalog_conflict");
      verified = await acquire(() => operations.verifyMySqlBackupArtifact({
        ...artifactOptions(), backupId: settings.BACKUP_ID, expectedAnchor: anchor,
        expectedEvidence: {
          sourceSnapshotSha256: entry.sourceSnapshotSha256, sourceBackupSha256: entry.sourceBackupSha256,
          artifactManifestSha256: entry.artifactManifestSha256, providerEvidenceSha256: entry.providerEvidenceSha256,
        }, deadlineMs: budget.remaining(),
      }));
      if (command === "verify-artifact") {
        summary = JSON.stringify({ status: "ok", command, backupId: settings.BACKUP_ID,
          artifactVerified: true, ...verified!.evidence, entrySha256: entry.entrySha256 });
      } else {
        const selected = restore!;
        // A selected v2 target must remain auditable after prepare makes normal
        // runtime startup fail closed. Require this capability before consuming
        // the external epoch or importing any bytes, not after the fact.
        if (verified.manifest.version !== 1
          && (refKey === undefined || !dependencies.connectCaptureRestoreMaintenance)) {
          throw cliError("invalid_configuration");
        }
        operator = await acquire(() => operations.acquireMySqlBackupArtifactOperator({
          sourceUrl: mysql.MYSQL_URL, targetUrl: selected.BACKUP_RESTORE_TARGET_MYSQL_URL,
          artifactDirectory: common.artifactDirectory, localOnlyAck: true, fleetStoppedAck: true,
          deadlineMs: budget.remaining(),
          operationAbortSignal: budget.signal,
          ...(refKey === undefined ? {} : { tenantTelemetryRefKey: refKey }),
          ...(common.nodeEnv === undefined ? {} : { nodeEnv: common.nodeEnv }),
        }));
        await step(() => operator!.assertStoreBinding(source, "source"));
        // Check permanent external authority under the actual source lock. A different
        // artifact directory or target must not turn an old epoch into a new import.
        await reconcileExternalChain(source, adapter, DEFAULT_PAGE_SIZE, step, settings.BACKUP_ID, {
          restoreRunId: selected.RESTORE_RUN_ID, runtimeEpochSha256: journalConfig!.runtimeEpochSha256,
        });
        await step(() => operator!.bindRestoreOperation({
          manifest: verified!.manifest, evidence: verified!.evidence,
          restoreRunId: selected.RESTORE_RUN_ID,
          runtimeEpochSha256: journalConfig!.runtimeEpochSha256,
        }));
        const prepare = { backupId: settings.BACKUP_ID, restoreRunId: selected.RESTORE_RUN_ID,
          epochId: selected.BACKUP_RUNTIME_EPOCH_ID, sourceBackupSha256: verified!.evidence.sourceBackupSha256,
          ...(verified.manifest.version !== 1 ? { captureCheckpointSha256: verified.manifest.captureCheckpoint.checkpointSha256 } : {}) };
        reservationAttempted = true;
        const sourcePrepared = await prepareSelectedRestore(source, adapter, config, journalConfig!, journalAdapters, prepare, step);
        // Source prepare atomically fences this database. Its restricted facade
        // must reject subsequent reads/mirroring while that run is pending.
        // Revalidate only the actual complete external authority under the held
        // GCM/operator budget; do not reopen or weaken the fenced source.
        const fresh = await readSelectedRestoreCatalog(adapter, config, verified!, selected.RESTORE_RUN_ID,
          journalConfig!.runtimeEpochSha256, DEFAULT_PAGE_SIZE, step);
        if (!exactAvailability(entry, fresh.availability) || fresh.resolution !== undefined
          || sourcePrepared.value.reservation.phase !== "reserved"
          || fresh.reservation.adapterProtocol !== config.adapterProtocol
          || fresh.reservation.catalogNamespaceSha256 !== config.catalogNamespaceSha256
          || fresh.reservation.catalogTargetSha256 !== config.catalogTargetSha256) throw cliError("catalog_conflict");
        // Compare all immutable adapter reservation fields, not local DB time,
        // binding digests or internal control columns rebuilt after import.
        for (const field of ["backupId", "restoreRunId", "entrySha256", "runtimeEpochSha256",
          "reservationOperationSha256", "reservationReceiptSha256", "catalogSequence",
          "previousCatalogEventRootSha256", "catalogEventRootSha256", "catalogEventSha256"] as const) {
          if (fresh.reservation[field] !== sourcePrepared.value.reservation[field]) throw cliError("catalog_conflict");
        }
        importAttempted = true;
        await step(() => operations.importVerifiedMySqlBackupArtifact(verified!, {
          targetUrl: selected.BACKUP_RESTORE_TARGET_MYSQL_URL, tools: binaries!, operator: operator!,
          restoreRunId: selected.RESTORE_RUN_ID, runtimeEpochSha256: journalConfig!.runtimeEpochSha256,
          localOnlyAck: true, fleetStoppedAck: true, deadlineMs: budget.remaining(),
          operationAbortSignal: budget.signal,
          ...(common.nodeEnv === undefined ? {} : { nodeEnv: common.nodeEnv }),
        }));
        targetStore = await acquire(() => connectArtifactStore(selected.BACKUP_RESTORE_TARGET_MYSQL_URL));
        const target = targetStore!;
        await step(() => operator!.assertStoreBinding(target, "target"));
        const restoredAnchor = await step(() => target.getTenantBackupSnapshotAnchor(settings.BACKUP_ID));
        if (!restoredAnchor || restoredAnchor.anchorSha256 !== verified!.manifest.anchor.anchorSha256
          || restoredAnchor.schemaMigrationRootSha256 !== verified!.manifest.schemaMigrationRootSha256) {
          throw cliError("invalid_durable_state");
        }
        const prepared = await prepareSelectedRestore(target, adapter, config, journalConfig!, journalAdapters, prepare, step);
        if (verified.manifest.version !== 1) {
          const checkpointSha256 = verified.manifest.captureCheckpoint.checkpointSha256;
          // Drop the pre-prepare source-maintenance facade, then cold-open an exact-run
          // facade while the authenticated artifact and operator locks remain
          // held. This does not replay fences, activate runtime, or grant writes.
          await step(() => target.close());
          targetStore = undefined;
          targetMaintenance = await acquire(() => dependencies.connectCaptureRestoreMaintenance!({
            url: selected.BACKUP_RESTORE_TARGET_MYSQL_URL, connectionLimit: 2,
            tenantTelemetryRefKey: refKey!, operationAbortSignal: budget.signal,
            selector: {
              backupId: settings.BACKUP_ID, restoreRunId: selected.RESTORE_RUN_ID,
              checkpointSha256,
              artifactManifestSha256: verified!.evidence.artifactManifestSha256,
              sourceSnapshotSha256: verified!.evidence.sourceSnapshotSha256,
              providerEvidenceSha256: verified!.evidence.providerEvidenceSha256,
              reservationSha256: prepared.value.reservation.reservationSha256,
              reservationReceiptSha256: prepared.value.reservation.reservationReceiptSha256,
              fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1",
            },
          }, stoppedProfile));
          const maintenance = targetMaintenance;
          await step(() => operator!.assertStoreBinding(maintenance, "target"));
          const boundRun = await step(() => maintenance.getTenantRestoreReplayRun(selected.RESTORE_RUN_ID));
          if (!boundRun || boundRun.phase !== "prepared"
            || boundRun.runtimeEpochSha256 !== prepared.value.reservation.runtimeEpochSha256
            || await step(() => maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt()) !== null) {
            throw cliError("invalid_durable_state");
          }
        }
        await step(() => operator!.markRestorePrepared(selected.RESTORE_RUN_ID));
        summary = JSON.stringify({ status: "ok", command, backupId: settings.BACKUP_ID,
          artifactVerified: true, ...verified!.evidence, restoreRunId: selected.RESTORE_RUN_ID,
          restorePhase: prepared.value.replayRun.phase,
          runtimeEpochSha256: prepared.value.reservation.runtimeEpochSha256,
          reservationSha256: prepared.value.reservation.reservationSha256,
          runtimeActivated: false, fenceReplayComplete: false, requiresExplicitReplayAndActivation: true });
      }
    }
    budget.check();
  } catch (error) {
    operationError = withRestoreBoundary(error);
  }
  // Abort native clients before releasing the operator locks. In-flight COMMIT/CAS
  // may already have succeeded: cancellation is not a rollback guarantee.
  budget.abort();
  let nativeClosed = false;
  const nativeClose = budget.trackCleanup(async () => {
    await closeAllSettled([
      targetMaintenance, targetStore, store, adapterResource, ...journalResources, ...sourceJournalResources,
    ]);
    nativeClosed = true;
  });
  await boundedCleanup(() => nativeClose);
  const settled = budget.settled();
  const drained = await boundedCleanup(() => settled);
  const release = () => closeAllSettled([verified, operator]);
  let released = false;
  if (drained) {
    const releasing = release();
    released = await boundedCleanup(() => releasing);
    if (released) refKey?.fill(0);
    else void releasing.finally(() => refKey?.fill(0)).catch(() => {});
  } else {
    // A 250ms foreground cleanup ceiling is not permission to release locks.
    // Both successful and rejected native closes must settle, as must every
    // abandoned operation's late disposal, before this release can start.
    void settled.then(async () => { try { await release(); } finally { refKey?.fill(0); } }).catch(() => {});
  }
  if (operationError !== undefined) throw operationError;
  if (!nativeClosed || !drained || !released || summary === undefined) {
    throw withRestoreBoundary(cliError("operation_failed"));
  }
  try {
    budget.assertBeforeDeadline();
    dependencies.writeLine(summary);
  } catch (error) {
    throw withRestoreBoundary(error);
  }
  return 0;
}

/** Continue an ALREADY imported authenticated v2 selection. No ordinary source
 * or target SessionStore is opened; no reserve, prepare, import or implicit
 * runtime/capture activation is available in this branch. */
async function runSelectedContinuation(command: SelectedArtifactCommand, env: NodeJS.ProcessEnv,
  dependencies: BackupCatalogCliDependencies, refKeyPath: string | undefined): Promise<number> {
  if (env.NODE_ENV === "production" || refKeyPath === undefined || !dependencies.connectCaptureArtifactRestoreMaintenance) {
    throw cliError("invalid_configuration");
  }
  const settings = SelectedContinuationEnv.parse(env);
  const ack = command === "replay-selected" ? "BACKUP_RESTORE_REPLAY_ACK"
    : command === "verify-selected" ? "BACKUP_RESTORE_VERIFY_ACK"
      : command === "activate-selected" ? "BACKUP_RESTORE_RUNTIME_ACTIVATION_ACK"
        : command === "resolve-selected" ? "BACKUP_RESTORE_CATALOG_RESOLUTION_ACK" : undefined;
  if (ack !== undefined && env[ack] !== "1") throw cliError("invalid_configuration");
  const capture = command === "activate-capture-selected" ? SelectedCaptureAcks.parse(env) : undefined;
  let authorityConfiguration: ReturnType<typeof parseSessionAuthorityOperatorConfiguration> | undefined;
  try {
    if (command === "activate-selected") {
      authorityConfiguration = parseSessionAuthorityOperatorConfiguration(env);
      // Both independent native owners must select the exact same operator
      // endpoint; actual server/database identity is additionally checked below.
      if (authorityConfiguration.url !== settings.BACKUP_RESTORE_TARGET_MYSQL_URL) throw Error("invalid_configuration");
    } else if (Reflect.ownKeys(env).some(key => typeof key === "string" && key.startsWith("AUTHORITY_"))) {
      throw Error("invalid_configuration");
    }
  } catch { throw cliError("invalid_configuration"); }
  // Validate all acknowledgements/configuration before key reads or adapters'
  // startup probes, which may perform conditional external test writes.
  const budget = artifactBudget(env, dependencies, authorityConfiguration?.timeoutMs), pageSize = parsePageSize(env);
  const config = loadCatalogRuntimeConfig(env, dependencies, false);
  const journalConfig = loadRestoreRuntimeConfig(env, settings.BACKUP_RUNTIME_EPOCH_ID, dependencies);
  if (config.logicalDatabaseNamespaceSha256 !== journalConfig.logicalDatabaseNamespaceSha256) throw cliError("invalid_configuration");
  const replayPageSize = boundedInteger(env.RESTORE_REPLAY_PAGE_SIZE, DEFAULT_PAGE_SIZE, 1_000);
  const operations = dependencies.artifactOperations ?? mysqlArtifact;
  let refKey: Buffer | undefined;
  let operator: Awaited<ReturnType<typeof operations.acquireMySqlBackupArtifactOperator>> | undefined;
  let verified: Awaited<ReturnType<typeof operations.verifyMySqlBackupArtifact>> | undefined;
  let maintenance: TenantTelemetryCaptureRestoreMaintenance | undefined;
  let adapter: TenantBackupCatalogAdapter | undefined;
  let journalAdapters: readonly RestoreAdapter[] = [];
  let summary: string | undefined, operationError: unknown;
  let mutationAttempted = false;
  let authorityContext: SessionAuthorityBindingOperatorContext | undefined;
  const boundary = (error: unknown) => mutationAttempted
    ? new BackupCatalogCliError(errorCode(error), undefined, { restoreMutationMayBeCommitted: true,
      runtimeActivationMayBeCommitted: command === "activate-selected", captureActivationMayBeCommitted: command === "activate-capture-selected",
      ...(command === "resolve-selected" ? { catalogResolutionMayBeCommitted: true as const } : {}) })
    : error;
  const acquire = <T extends { close(): Promise<void> }>(operation: () => Promise<T>) => budget.run(operation, (value) => value.close());
  const step: AsyncStep = async (operation) => {
    if (operator) await budget.run(() => operator!.assertHeld());
    const value = await budget.run(operation);
    if (operator) await budget.run(() => operator!.assertHeld());
    return value;
  };
  const beforeMutation = () => { mutationAttempted = true; };
  try {
    if (authorityConfiguration) {
      authorityContext = await budget.run(() => (dependencies.loadAuthorityContext ?? loadSessionAuthorityOperatorContext)(
        authorityConfiguration!, budget.signal));
    }
    const profile: MysqlRestoreJournalMaintenanceProfile = authorityContext
      ? { kind: "operator-maintenance", binding: authorityContext }
      : { kind: "stopped-fleet-maintenance", fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" };
    refKey = await budget.run(() => (dependencies.readRefKey ?? readTelemetryCaptureRefKey)(refKeyPath), async (late) => { late.fill(0); });
    if (!(refKey instanceof Uint8Array) || refKey.length !== 32) throw cliError("invalid_configuration");
    // sourceUrl intentionally means the sole EXISTING target database here.
    // Passing targetUrl would grant the empty-target import operator shape.
    // No old-source DB is read or expected to pass ordinary pending startup.
    operator = await acquire(() => operations.acquireMySqlBackupArtifactOperator({
      sourceUrl: settings.BACKUP_RESTORE_TARGET_MYSQL_URL,
      artifactDirectory: settings.BACKUP_ARTIFACT_DIRECTORY, tenantTelemetryRefKey: refKey!,
      localOnlyAck: true, fleetStoppedAck: true, deadlineMs: budget.remaining(), operationAbortSignal: budget.signal,
      ...(env.NODE_ENV === undefined ? {} : { nodeEnv: env.NODE_ENV }),
    }));
    if (authorityContext) {
      const fixed = captureSessionAuthorityBindingCommand(authorityContext.command);
      const physicalIdentity = sha256(canonicalJson({ scope: "mysql-physical-database-identity-v1",
        serverUuid: fixed.serverUuid, database: fixed.applicationDatabase }));
      if (operator.sourceIdentitySha256 !== physicalIdentity) throw cliError("invalid_configuration");
    }
    verified = await acquire(() => operations.verifyMySqlBackupArtifact({
      artifactDirectory: settings.BACKUP_ARTIFACT_DIRECTORY, keyFile: settings.BACKUP_ARTIFACT_KEY_FILE,
      backupId: settings.BACKUP_ID, tenantTelemetryRefKey: refKey!, localOnlyAck: true,
      maxBytes: budget.maxBytes, deadlineMs: budget.remaining(), operationAbortSignal: budget.signal,
      ...(env.NODE_ENV === undefined ? {} : { nodeEnv: env.NODE_ENV }),
    }));
    await step(async () => {}); // Recheck operator ownership after actual-byte authentication.
    if (verified.manifest.version === 1 || verified.manifest.backupId !== settings.BACKUP_ID
      || verified.manifest.anchor.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256) {
      throw cliError("invalid_durable_state");
    }
    const authenticated = verified;
    const checkpointSha256 = verified.manifest.captureCheckpoint.checkpointSha256;
    maintenance = await acquire(() => dependencies.connectCaptureArtifactRestoreMaintenance!({
      url: settings.BACKUP_RESTORE_TARGET_MYSQL_URL, connectionLimit: 2,
      tenantTelemetryRefKey: refKey!, operationAbortSignal: budget.signal,
      selection: { backupId: settings.BACKUP_ID, restoreRunId: settings.RESTORE_RUN_ID,
        checkpointSha256,
        artifactManifestSha256: authenticated.evidence.artifactManifestSha256,
        sourceSnapshotSha256: authenticated.evidence.sourceSnapshotSha256,
        providerEvidenceSha256: authenticated.evidence.providerEvidenceSha256,
        fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" },
    }, profile));
    const target = maintenance;
    await step(() => operator!.assertStoreBinding(target, "source"));
    const methods = ["getTenantRestoreReplayRun", "getTenantRestoreReplaySealedTargets", "getTenantRestoreReplayReceipt",
      "getTenantRestoreRuntimeControl", "getTenantRestoreRuntimeHeads", "getTenantRestoreJournalControl",
      "getTenantRestoreJournalControlTargets", "getTenantBackupRestoreSourceBinding", "getTenantBackupRuntimeReservation",
      "getTenantTelemetryCaptureRestoreHistoryReceipt", "close",
      ...(command === "replay-selected" ? ["recordTenantRestoreReplayFence"] : []),
      ...(command === "verify-selected" ? ["sealTenantRestoreReplay"] : []),
      ...(command === "activate-selected" ? ["activateTenantRestoreRuntime", "confirmSessionAuthorityBinding"] : []),
      ...(command === "resolve-selected" ? ["resolveTenantBackupRuntimeReservation", "getTenantTelemetryCaptureEpochCutoverReceipt"] : []),
      ...(capture ? ["activateTenantTelemetryCaptureRestoredEpoch", "getTenantTelemetryCaptureEpochCutoverReceipt"] : [])];
    if (methods.some((method) => typeof Reflect.get(target, method) !== "function")) throw cliError("invalid_configuration");
    // Missing facade capability must fail before external startup probe writes.
    adapter = dependencies.createCatalogAdapter(config, { operationAbortSignal: budget.signal });
    journalAdapters = Object.freeze([...dependencies.createJournalAdapters(journalConfig, { operationAbortSignal: budget.signal })]);
    await step(() => adapter!.validateStartup());
    for (const journal of journalAdapters) await step(() => journal.validateStartup());
    const external = await readSelectedRestoreCatalog(adapter, config, authenticated, settings.RESTORE_RUN_ID,
      journalConfig.runtimeEpochSha256, pageSize, step);
    const context = await readSelectedRestoreContext(target, journalConfig, authenticated, external, settings.RESTORE_RUN_ID, step);
    let run: TenantRestoreReplayRunRecord = context.run;
    let captureWritesAuthorized = false;
    let resolved: Awaited<ReturnType<TenantTelemetryCaptureRestoreMaintenance["resolveTenantBackupRuntimeReservation"]>> | undefined;
    if (command === "replay-selected") run = await replaySelectedRestore(target, context, journalConfig,
      journalAdapters, replayPageSize, step, beforeMutation);
    else if (command === "verify-selected") run = await verifySelectedRestore(target, context, step, beforeMutation);
    else if (command === "activate-selected") run = await activateSelectedRestore(target, context, journalConfig,
      journalAdapters, authenticated, refKey, step, beforeMutation);
    else if (command === "resolve-selected") resolved = await resolveSelectedRestore(target, context, adapter, config,
      journalConfig, journalAdapters, authenticated, refKey, pageSize, step, beforeMutation);
    else {
      run = await readActivatedSelectedRestore(target, context, authenticated, refKey, step);
      await assertSelectedRestoreFreshHeads(context, journalConfig, journalAdapters, step);
      const input = { expectedRuntimeEpochSha256: journalConfig.runtimeEpochSha256,
        configuredFleetRootSha256: capture!.TELEMETRY_CAPTURE_CONFIGURED_FLEET_ROOT_SHA256,
        legacyWritersDrainedAck: "legacy-writers-drained-v1" as const,
        producerReadyAck: "provider-step-error-v2-ready-v1" as const };
      beforeMutation();
      let returned: Awaited<ReturnType<TenantTelemetryCaptureRestoreMaintenance["activateTenantTelemetryCaptureRestoredEpoch"]>> | undefined;
      try { returned = await step(() => target.activateTenantTelemetryCaptureRestoredEpoch(input)); }
      catch { /* Durable exact receipt, not a response discriminator, decides success. */ }
      const receipt = await step(() => target.getTenantTelemetryCaptureEpochCutoverReceipt());
      const history = await step(() => target.getTenantTelemetryCaptureRestoreHistoryReceipt());
      if (!receipt || !history || authenticated.manifest.version === 1) throw cliError("invalid_durable_state");
      validateTenantTelemetryCaptureEpochCutoverReceipt(receipt, history, authenticated.manifest.captureCheckpoint, refKey);
      if (returned) {
        validateTenantTelemetryCaptureEpochCutoverReceipt(returned, history, authenticated.manifest.captureCheckpoint, refKey);
        if (returned.receiptSha256 !== receipt.receiptSha256) throw cliError("invalid_durable_state");
      }
      if (receipt.runtimeEpochSha256 !== input.expectedRuntimeEpochSha256
        || receipt.configuredFleetRootSha256 !== input.configuredFleetRootSha256) throw cliError("invalid_durable_state");
      await assertSelectedRestoreFreshHeads(context, journalConfig, journalAdapters, step);
      captureWritesAuthorized = true;
    }
    if (run.phase === "aborted") throw cliError("invalid_durable_state");
    // Original 0030 response-loss recovery proves its receipt; this independent
    // read must also prove that the same fixed authority transition committed.
    if (authorityContext) await step(() => target.confirmSessionAuthorityBinding());
    budget.check();
    summary = JSON.stringify({ status: "ok", command, backupId: settings.BACKUP_ID, restoreRunId: settings.RESTORE_RUN_ID,
      artifactVerified: true, restorePhase: run.phase, runtimeEpochSha256: run.runtimeEpochSha256,
      fenceReplayComplete: run.entryCount === run.expectedEntryCount, runtimeActivated: run.phase === "active",
      // Non-capture commands do not claim the current absence of a previously
      // committed cutover. They only report what this invocation confirmed.
      captureCutoverConfirmed: captureWritesAuthorized,
      ...(captureWritesAuthorized ? { captureWritesAuthorized: true } : {}), historicalOperationRecoveryAuthorized: false,
      ...(resolved ? { catalogResolutionConfirmed: true, disposition: resolved.disposition, phase: resolved.value.phase,
        reservationSha256: resolved.value.reservationSha256,
        resolutionCatalogSequence: resolved.value.phase === "activated" ? resolved.value.resolutionCatalogSequence : null } : {}),
      requiresExplicitCatalogResolution: resolved === undefined && run.phase === "active" && context.reservation.phase !== "activated",
      allDomainsComplete: false, contentPurgeExecuted: false, importAttempted: false });
  } catch (error) { operationError = boundary(error); }
  // Same settlement barrier as first import: abort is not rollback, and a
  // rejected close does not allow another live operation to outlast the locks.
  budget.abort();
  let nativeClosed = false;
  const nativeClose = budget.trackCleanup(async () => {
    await closeAllSettled([maintenance, adapter, ...journalAdapters]);
    nativeClosed = true;
  });
  await boundedCleanup(() => nativeClose);
  const settled = budget.settled(), drained = await boundedCleanup(() => settled);
  const release = () => closeAllSettled([verified, operator]);
  let released = false;
  if (drained) {
    const releasing = release(); released = await boundedCleanup(() => releasing);
    if (released) refKey?.fill(0); else void releasing.finally(() => refKey?.fill(0)).catch(() => {});
  } else void settled.then(async () => { try { await release(); } finally { refKey?.fill(0); } }).catch(() => {});
  if (operationError !== undefined) throw operationError;
  if (!nativeClosed || !drained || !released || summary === undefined) throw boundary(cliError("operation_failed"));
  try { budget.assertBeforeDeadline(); dependencies.writeLine(summary); } catch (error) { throw boundary(error); }
  return 0;
}

/** Explicit manual 0031 forward-fix only. This is not a selected continuation:
 * it does not authenticate artifact bytes, import, activate, or acquire artifact directory locks.
 * The operator retains the original physical-evidence/single-operator/fleet-stopped obligation. */
async function runStoppedLocalPrepare(
  env: NodeJS.ProcessEnv,
  dependencies: BackupCatalogCliDependencies,
  refKeyPath: string | undefined,
): Promise<number> {
  if (Reflect.ownKeys(env).some(key => typeof key === "string" && key.startsWith("AUTHORITY_"))
    || !dependencies.connectCaptureBackupSourceMaintenance) throw cliError("invalid_configuration");
  const mysql = MysqlEnv.parse(env), settings = PrepareRestoreEnv.parse(env);
  const config = loadCatalogRuntimeConfig(env, dependencies, false);
  const journalConfig = loadRestoreRuntimeConfig(env, settings.BACKUP_RUNTIME_EPOCH_ID, dependencies);
  if (config.logicalDatabaseNamespaceSha256 !== journalConfig.logicalDatabaseNamespaceSha256) {
    throw cliError("invalid_configuration");
  }
  const signalOwner = new AbortController();
  const stoppedProfile = Object.freeze({ kind: "stopped-fleet-maintenance" as const,
    fleetStoppedAck: "fleet-stopped-v1" as const, localOnlyAck: "local-only-v1" as const });
  let source: TenantTelemetryCaptureBackupSourceMaintenance | undefined;
  let sourceFactory: Promise<TenantTelemetryCaptureBackupSourceMaintenance> | undefined;
  let adapter: TenantBackupCatalogAdapter | undefined;
  const journalAdapters: RestoreAdapter[] = [];
  let refKey: Buffer | undefined, summary: string | undefined;
  let failure: { reason: unknown } | undefined;
  try {
    if (refKeyPath !== undefined) {
      try {
        refKey = await (dependencies.readRefKey ?? readTelemetryCaptureRefKey)(refKeyPath);
        if (!(refKey instanceof Uint8Array) || refKey.length !== 32) throw cliError("invalid_configuration");
      } catch { throw cliError("invalid_configuration"); }
    }
    adapter = dependencies.createCatalogAdapter(config, { operationAbortSignal: signalOwner.signal });
    journalAdapters.push(...dependencies.createJournalAdapters(journalConfig, { operationAbortSignal: signalOwner.signal }));
    await adapter.validateStartup();
    for (const journal of journalAdapters) await journal.validateStartup();
    // Register and await the actual factory; no timeout/race can detach a late native resource.
    // Never pass ordinary flags/schemaMetadata or an activation command to this closed port.
    sourceFactory = dependencies.connectCaptureBackupSourceMaintenance({ url: mysql.MYSQL_URL,
      connectionLimit: 2, operationAbortSignal: signalOwner.signal,
      ...(refKey === undefined ? {} : { tenantTelemetryRefKey: refKey }),
      fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" }, stoppedProfile);
    source = await sourceFactory;
    validateTenantBackupCatalogControlRecord(await source.getTenantBackupCatalogControl());
    const prepared = await prepareSelectedRestore(source, adapter, config, journalConfig, journalAdapters,
      { backupId: settings.BACKUP_ID, restoreRunId: settings.RESTORE_RUN_ID,
        epochId: settings.BACKUP_RUNTIME_EPOCH_ID, sourceBackupSha256: settings.SOURCE_BACKUP_SHA256 });
    summary = JSON.stringify({ status: "ok", command: "prepare-restore", disposition: prepared.disposition,
      backupId: prepared.value.binding.backupId, restoreRunId: prepared.value.replayRun.restoreRunId,
      restorePhase: prepared.value.replayRun.phase, runtimeEpochSha256: prepared.value.reservation.runtimeEpochSha256,
      reservationSha256: prepared.value.reservation.reservationSha256,
      catalogSequence: prepared.value.reservation.catalogSequence });
  } catch (reason) { failure = { reason }; }
  signalOwner.abort();
  // This Promise is the original accepted factory. Every fulfilled source, including a late one,
  // is joined before close; a rejected factory cannot be replaced with an ordinary connection.
  if (sourceFactory) {
    const settled = await Promise.allSettled([sourceFactory]);
    const result = settled[0]!;
    if (result.status === "fulfilled") source = result.value;
    else failure ??= { reason: result.reason };
  }
  const closed = await Promise.allSettled([
    closeSafely(source), closeSafely(adapter), ...journalAdapters.map(closeSafely),
  ].filter((operation): operation is Promise<void> => operation !== undefined));
  for (const result of closed) if (result.status === "rejected") failure ??= { reason: result.reason };
  try { refKey?.fill(0); } catch (reason) { failure ??= { reason }; }
  if (failure) throw failure.reason;
  if (summary === undefined) throw cliError("operation_failed");
  dependencies.writeLine(summary);
  return 0;
}

export async function runBackupCatalogCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: BackupCatalogCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const command = parseCommand(argv);
  // This opt-in is command-scoped and independent of artifact/selected ACKs.
  const stoppedLocalPrepare = stoppedLocalPrepareRequested(command, env);
  let refKeyPath: string | undefined;
  try { refKeyPath = tenantTelemetryOperatorRefKeyPath(env); }
  catch { throw cliError("invalid_configuration"); }
  if (stoppedLocalPrepare) return runStoppedLocalPrepare(env, dependencies, refKeyPath);
  if ((SELECTED_COMMANDS as readonly string[]).includes(command)) {
    return runSelectedContinuation(command as SelectedArtifactCommand, env, dependencies, refKeyPath);
  }
  if (command === "create-artifact" || command === "verify-artifact" || command === "restore-selected") {
    return runArtifactCommand(command, env, dependencies, refKeyPath);
  }
  let schemaMetadata: SchemaMetadataReaderConfig;
  try {
    if (Reflect.ownKeys(env).some(key => typeof key === "string" && key.startsWith("AUTHORITY_"))) throw Error("invalid_configuration");
    const parsed = loadMysqlSchemaRuntimeConfig(env, "mysql");
    if (!parsed) throw Error("invalid_configuration");
    schemaMetadata = parsed;
  } catch { throw cliError("invalid_configuration"); }
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
  let refKey: Buffer | undefined;
  try {
    if (refKeyPath !== undefined) {
      try {
        refKey = await (dependencies.readRefKey ?? readTelemetryCaptureRefKey)(refKeyPath);
        if (!(refKey instanceof Uint8Array) || refKey.length !== 32) throw cliError("invalid_configuration");
      }
      catch { throw cliError("invalid_configuration"); }
    }
    if (catalogAdapter) await catalogAdapter.validateStartup();
    for (const adapter of journalAdapters) await adapter.validateStartup();
    store = await dependencies.connectStore({
      url: mysql.MYSQL_URL,
      connectionLimit: command === "status" || command === "list" ? 1 : 2,
      migrationMode: "verify",
      schemaMetadata,
      ...(refKey === undefined ? {} : { tenantTelemetryRefKey: refKey }),
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
      const prepared = await prepareSelectedRestore(
        store, catalogAdapter!, catalogConfig!, journalConfig!, journalAdapters,
        { backupId: settings.BACKUP_ID, restoreRunId: settings.RESTORE_RUN_ID,
          epochId: settings.BACKUP_RUNTIME_EPOCH_ID,
          sourceBackupSha256: settings.SOURCE_BACKUP_SHA256 },
        unlimitedStep,
      );
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
  refKey?.fill(0);
  if (operationError !== undefined) throw operationError;
  if (closeResults.some((result) => result.status === "rejected") || summary === undefined) {
    throw cliError("operation_failed");
  }
  dependencies.writeLine(summary);
  return 0;
}

function errorCode(error: unknown): BackupCatalogCliErrorCode {
  if (error instanceof BackupCatalogCliError) return error.code;
  if (error instanceof SelectedRestoreError) return error.code;
  if (error instanceof mysqlArtifact.MySqlBackupArtifactError && error.code === "operation_deadline") {
    return "operation_deadline";
  }
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
  if (error instanceof BackupCatalogCliError && error.selectedBoundary) {
    return JSON.stringify({ status: "error", code: error.code, ...error.selectedBoundary,
      requiresExactReplay: true, importAttempted: false, requiresManualForwardFixIfReplayFails: true });
  }
  if (error instanceof BackupCatalogCliError && error.restoreBoundary) {
    return JSON.stringify({ status: "error", code: error.code, ...error.restoreBoundary,
      requiresManualForwardFix: true, runtimeActivated: false });
  }
  return JSON.stringify({ status: "error", code: errorCode(error) });
}
