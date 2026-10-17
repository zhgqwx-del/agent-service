import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import {
  BlobCleanupWorker,
  ConfiguredMcpToolSource,
  ConfiguredStaticSkillSource,
  type ConfiguredToolHookService,
  createTenantTelemetryApplicationDualWrite,
  createPersistedProviderFailureCapture,
  TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256,
  TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL,
  createFakeCredentialTargetExecutionAdapterState,
  ErasureWorker,
  FakeCredentialTargetExecutionAdapter,
  LegacyTombstoneCompensationWorker,
  LifecycleOutboxDispatcher,
  OrdinarySessionDeleteGraceRecovery,
  OrdinarySessionUsageRetentionWorker,
  PiEngine,
  PiSummariser,
  PurgePolicyEvaluator,
  SessionBlobService,
  SessionHost,
  StaticToolRegistry,
  TenantContentInventoryWorker,
  TenantCredentialRevocationWorker,
  TenantCredentialTargetExecutionWorker,
  TenantDatabasePurgeWorker,
  TenantRedisPurgeWorker,
  TenantRestoreJournalPublicationWorker,
  type TenantTelemetryApplicationDualWrite,
  TenantPurgeExecutionWorker,
  TenantPurgePlanWorker,
  TenantRuntimeCoordinator,
  TenantRuntimeRevocationWorker,
  UserDataExportCleanupWorker,
  UserDataExportWorker,
  builtinTools,
} from "@agent-service/core";
import {
  consoleTelemetrySink,
  createEphemeralStructuredTelemetry,
  createRuntimeMetrics,
  tenantRedisNamespaceSha256,
  type StructuredTelemetry,
  type StructuredTelemetryFields,
} from "@agent-service/protocol";
import { LocalAesGcmCipher, ProviderService, PROVIDER_PRESETS } from "@agent-service/providers";
import {
  FsBlobStore,
  S3BlobStore,
  MemoryEventBus,
  MemoryLeaseStore,
  MemorySessionStore,
  MysqlSessionStore,
  RedisEventBus,
  RedisLeaseStore,
  RedisSessionStatePurgeAdapter,
  SubjectDeletingError,
  tenantBackupCatalogRuntimeBindingSha256,
  type BlobCleanupStore,
  type BlobStorageControlStore,
  type BlobStore,
  type BlobManifestStore,
  type CredentialLifecycleStore,
  type EventBus,
  type ErasureJobStore,
  type ErasurePolicyEvaluationStore,
  type ErasureSessionCatalogStore,
  type ErasureSessionStore,
  type ErasureUsageReconciliationStore,
  type LeaseStore,
  type LifecycleOutboxStore,
  type LegacyTombstoneCompensationStore,
  type RetentionPolicyStore,
  type RestoreReplayStore,
  type SubjectLifecycleStore,
  type TenantCredentialRevocationStore,
  type TenantCredentialResponsibilityStore,
  type TenantCredentialTargetExecutionStore,
  type TenantBackupCatalogStore,
  type TenantDatabasePurgeStore,
  type TenantRedisPurgeStore,
  type TenantRestoreJournalStore,
  type TenantTelemetryLifecycleStore,
  type TenantTelemetryApplicationCaptureStore,
  type TenantTelemetryWriterStore,
  type TenantTelemetryPersistedProviderCaptureStore,
  type TenantContentInventoryStore,
  type TenantPurgeExecutionStore,
  type TenantPurgePlanStore,
  type TenantRuntimeRevocationStore,
  type SessionStore,
  type UsageLifecycleStore,
  type OrdinarySessionUsageRetentionStore,
  type UserDataExportCleanupStore,
  type UserDataExportJobStore,
  type UserDataExportRequestStore,
} from "@agent-service/store";
import { createApp } from "./app.js";
import { generateApiKey, hashApiKey } from "./auth.js";
import { createConfiguredToolHooks } from "./hooks-runtime.js";
import { createLocalFakeCredentialTargetReferenceCapture } from
  "./credential-target-reference-local.js";
import { reconcileBlobStorageControlForRuntime } from "./blob-storage-control.js";
import { assertBlobStorageMigrationRuntimeReady } from "./blob-storage-migration-gate.js";
import { loadConfig } from "./config.js";
import { isDirectCliEntrypoint } from "./cli-entrypoint.js";
import { RouterErasureSessionExecutor } from "./erasure-executor.js";
import { RouterPurgePolicyEvaluationGate } from "./purge-policy-evaluation-gate.js";
import { RouterTenantErasureAdmissionGate } from "./tenant-erasure-admission-gate.js";
import { RouterTenantCredentialRevocationGate } from "./tenant-credential-revocation-gate.js";
import { RouterTenantCredentialTargetExecutionGate } from "./tenant-credential-target-execution-gate.js";
import { RouterTenantDatabasePurgeGate } from "./tenant-database-purge-gate.js";
import { RouterOrdinarySessionUsageRetentionGate } from "./ordinary-session-usage-retention-gate.js";
import { RouterTenantRedisPurgeGate } from "./tenant-redis-purge-gate.js";
import {
  createTenantRestoreJournalAdapters,
} from "./tenant-restore-journal-config.js";
import { RouterTenantRestoreJournalGate } from "./tenant-restore-journal-gate.js";
import {
  TenantRestoreJournalPreflightError,
  reconcileTenantRestoreJournalRuntimeForStartup,
  type TenantRestoreJournalPreflightSummary,
} from "./tenant-restore-journal-preflight.js";
import { RouterTenantPurgeExecutionGate } from "./tenant-purge-execution-gate.js";
import { RouterTenantRuntimeDrainClient } from "./tenant-runtime-drain-client.js";
import { LocalTenantRuntimeDrain } from "./tenant-runtime-local-drain.js";
import {
  reconcileTenantTelemetryWriterForStartup,
  type TenantTelemetryWriterRuntime,
} from "./tenant-telemetry-writer-config.js";
import { RouterPersistedProviderCaptureGate } from "./persisted-provider-capture-gate.js";

const RUNNER_TELEMETRY_LEVEL = {
  "runner.bootstrap.dev_key_skipped": "warn",
  "runner.bootstrap.dev_key_seeded": "warn",
  "runner.bootstrap.admin_key_inactive": "warn",
  "runner.bootstrap.admin_key_present": "info",
  "runner.bootstrap.admin_key_output_rejected": "error",
  "runner.bootstrap.admin_key_store_failed": "error",
  "runner.bootstrap.admin_key_written": "info",
  "runner.lifecycle.draining": "info",
  "runner.lifecycle.started": "info",
  "runner.process.start_failed": "error",
  "runner.runtime.ownership_lost": "warn",
} as const;

export type RunnerTelemetryEventCode = keyof typeof RUNNER_TELEMETRY_LEVEL;
type RunnerMainTelemetryFields = Pick<
  StructuredTelemetryFields,
  "gateEnabledCount" | "gateDisabledCount"
>;
const RUNNER_TELEMETRY_OUTPUT: Pick<Console, "info" | "warn" | "error"> = {
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};
const runnerProcessTelemetry = createEphemeralStructuredTelemetry(
  "runner",
  RUNNER_TELEMETRY_OUTPUT,
);

/**
 * Compatibility boundary for core components that still accept a Console-shaped logger. Dynamic
 * arguments are intentionally discarded: session/turn/outbox IDs and arbitrary Error objects must
 * not bypass the structured telemetry schema while those components migrate to native events.
 */
export function createContentFreeRunnerLogger(
  telemetry: StructuredTelemetry,
): Pick<Console, "info" | "warn" | "error"> {
  const emit = (level: "info" | "warn" | "error", code: "runner.runtime.info" | "runner.runtime.warning" | "runner.runtime.error") => {
    try {
      telemetry[level](code);
    } catch {
      // A failed telemetry sink must not alter runtime, fence, or cleanup behavior.
    }
  };
  return Object.freeze({
    info: (..._values: unknown[]) => emit("info", "runner.runtime.info"),
    warn: (..._values: unknown[]) => emit("warn", "runner.runtime.warning"),
    error: (..._values: unknown[]) => emit("error", "runner.runtime.error"),
  });
}

const runnerRuntimeLogger = createContentFreeRunnerLogger(runnerProcessTelemetry);

/**
 * Bootstrap-safe telemetry boundary. String-valued fields are intentionally impossible here: raw
 * tenant IDs, runner addresses, provider IDs, URLs, locators and dependency errors must never
 * reach the process log. The future durable telemetry adapter can consume this exact envelope.
 */
export function emitRunnerTelemetryEvent(
  event: RunnerTelemetryEventCode,
  fields: RunnerMainTelemetryFields = {},
): void {
  const level = RUNNER_TELEMETRY_LEVEL[event];
  runnerProcessTelemetry[level](event, fields);
}

/**
 * Writes the first admin key through a create-only, owner-readable channel. The path and the key
 * are never included in an error. A file left behind after an ambiguous database failure is
 * intentional: operators must reconcile it rather than risk silently minting a second secret.
 */
export async function writeAdminBootstrapOutputFile(
  outputPath: string,
  key: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let failed = false;
  try {
    handle = await open(outputPath, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${key}\n`, { encoding: "utf8" });
    await handle.sync();
  } catch {
    failed = true;
  }
  if (handle) {
    try {
      await handle.close();
    } catch {
      failed = true;
    }
  }
  // fsyncing only the file does not make the newly created directory entry durable across a
  // power loss. Persist the parent before the key can be committed to the database. A platform or
  // filesystem that cannot provide this guarantee fails closed and leaves the create-only file for
  // operator reconciliation.
  try {
    directoryHandle = await open(dirname(outputPath), "r");
    await directoryHandle.sync();
  } catch {
    failed = true;
  }
  if (directoryHandle) {
    try {
      await directoryHandle.close();
    } catch {
      failed = true;
    }
  }
  if (failed) {
    throw new Error("admin bootstrap output file could not be created safely");
  }
}

export async function startRunner(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadConfig(env);
  const tenantRuntimeBootId = randomUUID();
  const tenantTelemetryRefKey = cfg.TENANT_TELEMETRY_REF_KEY === undefined
    ? undefined
    : Buffer.from(cfg.TENANT_TELEMETRY_REF_KEY, "hex");
  const redisNamespaceSha256 = cfg.REDIS_URL && cfg.REDIS_NAMESPACE_ID
    ? tenantRedisNamespaceSha256(cfg.REDIS_NAMESPACE_ID, cfg.REDIS_PREFIX)
    : undefined;
  const store: SessionStore
    & LifecycleOutboxStore
    & CredentialLifecycleStore
    & BlobManifestStore
    & BlobCleanupStore
    & BlobStorageControlStore
    & SubjectLifecycleStore
    & TenantCredentialRevocationStore
    & TenantCredentialResponsibilityStore
    & TenantCredentialTargetExecutionStore
    & TenantBackupCatalogStore
    & TenantDatabasePurgeStore
    & TenantRedisPurgeStore
    & TenantRestoreJournalStore
    & RestoreReplayStore
    & TenantContentInventoryStore
    & TenantPurgeExecutionStore
    & TenantPurgePlanStore
    & TenantRuntimeRevocationStore
    & ErasureJobStore
    & ErasurePolicyEvaluationStore
    & ErasureSessionCatalogStore
    & ErasureUsageReconciliationStore
    & LegacyTombstoneCompensationStore
    & RetentionPolicyStore
    & UsageLifecycleStore
    & OrdinarySessionUsageRetentionStore
    & ErasureSessionStore
    & UserDataExportRequestStore
    & UserDataExportJobStore
    & UserDataExportCleanupStore
    & TenantTelemetryLifecycleStore
    & TenantTelemetryApplicationCaptureStore
    & TenantTelemetryPersistedProviderCaptureStore
    & TenantTelemetryWriterStore = cfg.STORE === "mysql"
    ? await MysqlSessionStore.connect({
      url: cfg.MYSQL_URL,
      ...(redisNamespaceSha256 === undefined
        ? {}
        : { tenantRedisPurgeNamespaceSha256: redisNamespaceSha256 }),
      ...(tenantTelemetryRefKey === undefined
        ? {}
        : { tenantTelemetryRefKey }),
      ...(cfg.PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED && cfg.NODE_ENV !== "production"
        ? { tenantTelemetryPersistedProviderCaptureLocalOnly: true } : {}),
    })
    : new MemorySessionStore(
      { now: () => Date.now() },
      {
        ...(tenantTelemetryRefKey === undefined ? {} : { tenantTelemetryRefKey }),
        ...(cfg.PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED && cfg.NODE_ENV !== "production"
          ? { tenantTelemetryPersistedProviderCaptureLocalOnly: true } : {}),
      },
    );

  let tenantRestoreJournalWorker: TenantRestoreJournalPublicationWorker | undefined;
  let tenantRestoreJournalGate: RouterTenantRestoreJournalGate | undefined;
  let tenantRestoreJournalPreflight: TenantRestoreJournalPreflightSummary | undefined;
  let tenantRestoreJournalAdapters: ReturnType<typeof createTenantRestoreJournalAdapters> = [];
  let tenantRestoreJournalClosePromise: Promise<void> | undefined;
  let tenantTelemetryWriterRuntime: TenantTelemetryWriterRuntime | undefined;
  let providerTenantTelemetry: TenantTelemetryApplicationDualWrite | undefined;
  let tenantTelemetryRetryTimer: ReturnType<typeof setInterval> | undefined;
  let ordinarySessionDeleteGraceRecovery: OrdinarySessionDeleteGraceRecovery | undefined;
  let ordinarySessionUsageRetentionWorker: OrdinarySessionUsageRetentionWorker | undefined;
  let skills: ConfiguredStaticSkillSource | undefined;
  let hooks: ConfiguredToolHookService | undefined;
  let hooksInitializationFailed = false;
  let closeHookBootstrapResources: (() => Promise<void>) | undefined;
  const persistedProviderCaptureGate = cfg.PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED
    ? new RouterPersistedProviderCaptureGate({
      routerBaseUrl: cfg.ERASURE_ROUTER_URL!, internalToken: cfg.INTERNAL_ROUTER_TOKEN,
      runnerId: cfg.RUNNER_ID, bootId: tenantRuntimeBootId,
    }) : undefined;
  const closeTenantRestoreJournal = (): Promise<void> => {
    if (tenantRestoreJournalClosePromise) return tenantRestoreJournalClosePromise;
    tenantRestoreJournalClosePromise = tenantRestoreJournalWorker !== undefined
      ? tenantRestoreJournalWorker.stop()
      : Promise.allSettled(tenantRestoreJournalAdapters.map((adapter) => adapter.close()))
        .then(() => {});
    return tenantRestoreJournalClosePromise;
  };
  const workerRequiredError = new Error(
    "TENANT_RESTORE_JOURNAL_WORKER_ENABLED=1 is required after durable restore journal activation",
  );
  try {
    tenantRestoreJournalAdapters = cfg.tenantRestoreJournal === undefined
      ? []
      : createTenantRestoreJournalAdapters(cfg.tenantRestoreJournal);
    tenantRestoreJournalPreflight = await reconcileTenantRestoreJournalRuntimeForStartup({
      store,
      ...(cfg.tenantRestoreJournal === undefined
        ? {}
        : {
            config: cfg.tenantRestoreJournal,
            adapters: tenantRestoreJournalAdapters,
          }),
    });
    if (tenantRestoreJournalPreflight.state === "ready"
      && !cfg.TENANT_RESTORE_JOURNAL_WORKER_ENABLED) {
      throw workerRequiredError;
    }
    if (cfg.TENANT_RESTORE_JOURNAL_WORKER_ENABLED) {
      tenantRestoreJournalGate = new RouterTenantRestoreJournalGate({
        routerBaseUrl: cfg.ERASURE_ROUTER_URL!,
        internalToken: cfg.INTERNAL_ROUTER_TOKEN,
        requestTimeoutMs: cfg.TENANT_ERASURE_BARRIER_TIMEOUT_MS,
      });
      tenantRestoreJournalWorker = new TenantRestoreJournalPublicationWorker({
        store,
        adapters: tenantRestoreJournalAdapters,
        canExecute: () => tenantRestoreJournalGate!.canExecute(),
        logger: runnerRuntimeLogger,
      }, {
        pollIntervalMs: cfg.TENANT_RESTORE_JOURNAL_WORKER_POLL_MS,
        leaseMs: cfg.TENANT_RESTORE_JOURNAL_WORKER_LEASE_MS,
        batchSize: cfg.TENANT_RESTORE_JOURNAL_WORKER_BATCH_SIZE,
        materializeBatchSize: cfg.TENANT_RESTORE_JOURNAL_MATERIALIZE_BATCH_SIZE,
        retryBaseMs: cfg.TENANT_RESTORE_JOURNAL_RETRY_BASE_MS,
        retryMaxMs: cfg.TENANT_RESTORE_JOURNAL_RETRY_MAX_MS,
      });
    } else {
      // A dormant configuration is still validated by preflight, then releases its remote client
      // before unrelated runtime initialization begins.
      await closeTenantRestoreJournal();
      tenantRestoreJournalAdapters = [];
    }
  } catch (error) {
    await closeTenantRestoreJournal();
    await store.close().catch(() => {});
    if (error instanceof TenantRestoreJournalPreflightError || error === workerRequiredError) {
      throw error;
    }
    throw new Error("tenant restore journal startup failed");
  }

  try {
  if (cfg.STORE === "mysql") {
    try {
      // The offline mover owns the whole Blob namespace while active. Read its durable control
      // through a separate connection and release that connection before any runtime work begins.
      await assertBlobStorageMigrationRuntimeReady(cfg.MYSQL_URL);
    } catch (error) {
      await store.close().catch(() => {});
      throw error;
    }
  }
  let redisCutover: Awaited<ReturnType<TenantRedisPurgeStore["getTenantRedisPurgeCutover"]>>;
  let hasRedisPurgeJobs: boolean;
  try {
    redisCutover = await store.getTenantRedisPurgeCutover();
    hasRedisPurgeJobs = await store.hasTenantRedisPurgeJobs();
  } catch (error) {
    await store.close().catch(() => {});
    throw error;
  }
  if ((hasRedisPurgeJobs
      || redisCutover.controlGeneration === 1)
    && !cfg.TENANT_REDIS_PURGE_WORKER_ENABLED) {
    await store.close();
    throw new Error(
      "TENANT_REDIS_PURGE_WORKER_ENABLED=1 is required after durable T3g Redis purge work exists",
    );
  }
  let credentialTargetExecutionCutover:
    Awaited<ReturnType<TenantCredentialTargetExecutionStore[
      "getTenantCredentialTargetExecutionCutover"
    ]>>;
  let hasCredentialTargetExecutionJobs: boolean;
  try {
    credentialTargetExecutionCutover =
      await store.getTenantCredentialTargetExecutionCutover();
    hasCredentialTargetExecutionJobs =
      await store.hasTenantCredentialTargetExecutionJobs();
  } catch (error) {
    await store.close().catch(() => {});
    throw error;
  }
  if ((hasCredentialTargetExecutionJobs
      || credentialTargetExecutionCutover.controlGeneration === 1)
    && (!cfg.TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED
      || cfg.CREDENTIAL_TARGET_EXECUTION_ADAPTER !== "fake")) {
    await store.close();
    throw new Error(
      "the credential target execution worker and adapter are required after durable 0029 work exists",
    );
  }
  const lease: LeaseStore = cfg.REDIS_URL
    ? new RedisLeaseStore(cfg.REDIS_URL, cfg.REDIS_PREFIX)
    : new MemoryLeaseStore();
  const bus: EventBus = cfg.REDIS_URL
    ? new RedisEventBus(cfg.REDIS_URL, { prefix: cfg.REDIS_PREFIX })
    : new MemoryEventBus();
  const tenantRedisPurgeAdapter = cfg.REDIS_URL && redisNamespaceSha256
    ? new RedisSessionStatePurgeAdapter(cfg.REDIS_URL, {
      prefix: cfg.REDIS_PREFIX,
      namespaceSha256: redisNamespaceSha256,
    })
    : undefined;
  const tenantRedisPurgeGate = cfg.TENANT_REDIS_PURGE_WORKER_ENABLED
    ? new RouterTenantRedisPurgeGate({
      routerBaseUrl: cfg.ERASURE_ROUTER_URL!,
      internalToken: cfg.INTERNAL_ROUTER_TOKEN,
      requestTimeoutMs: cfg.TENANT_ERASURE_BARRIER_TIMEOUT_MS,
    })
    : undefined;
  const tenantRedisPurgeWorker = tenantRedisPurgeGate && tenantRedisPurgeAdapter
    ? new TenantRedisPurgeWorker({
      store,
      adapter: tenantRedisPurgeAdapter,
      canExecute: () => tenantRedisPurgeGate.canExecute(),
      logger: runnerRuntimeLogger,
    }, {
      pollIntervalMs: cfg.TENANT_REDIS_PURGE_WORKER_POLL_MS,
      leaseMs: cfg.TENANT_REDIS_PURGE_WORKER_LEASE_MS,
      batchSize: cfg.TENANT_REDIS_PURGE_WORKER_BATCH_SIZE,
      materializeBatchSize: cfg.TENANT_REDIS_PURGE_MATERIALIZE_BATCH_SIZE,
      targetPageSize: cfg.TENANT_REDIS_PURGE_TARGET_PAGE_SIZE,
      restorePageSize: cfg.TENANT_REDIS_PURGE_RESTORE_PAGE_SIZE,
      restoreIntervalMs: cfg.TENANT_REDIS_PURGE_RESTORE_INTERVAL_MS,
      retryBaseMs: cfg.TENANT_REDIS_PURGE_RETRY_BASE_MS,
      retryMaxMs: cfg.TENANT_REDIS_PURGE_RETRY_MAX_MS,
    })
    : undefined;
  try {
    // Completed/partial durable ACKs are already-authorized permanent fences. Reapply every one
    // before any worker or HTTP listener can observe a restored Redis namespace.
    await tenantRedisPurgeWorker?.replayDurableRestoreFences();

    // Credential tracking is a durable one-way cutover. Delay it until all T3g durable preflight
    // and restore work has succeeded, but still complete it before bootstrap mutations, workers or
    // the HTTP listener can expose this process as a writer.
    let credentialTracking = await store.readTenantCredentialTrackingCutover();
    if (
      cfg.CREDENTIAL_LIFECYCLE_TRACKING_ENABLED
      && credentialTracking.controlGeneration === 0
    ) {
      try {
        credentialTracking = await store.activateTenantCredentialTrackingCutover({
          expectedControlGeneration: 0,
        });
      } catch (error) {
        // Another new runner may have won the one-way activation race, or the activation response
        // may have been lost after commit. Only an independently re-read active cutover recovers it.
        credentialTracking = await store.readTenantCredentialTrackingCutover();
        if (credentialTracking.controlGeneration !== 1) throw error;
      }
    }
    if (
      cfg.CREDENTIAL_LIFECYCLE_TRACKING_ENABLED
      && credentialTracking.controlGeneration !== 1
    ) throw new Error("credential lifecycle tracking activation did not commit");
  } catch (error) {
    await Promise.all([
      tenantRedisPurgeAdapter?.close(),
      bus.close(),
      lease.close(),
      store.close(),
    ]);
    throw error;
  }
  const blobStore: BlobStore = cfg.BLOB_STORE === "s3"
    ? new S3BlobStore({
      bucket: cfg.BLOB_S3_BUCKET!,
      namespaceId: cfg.BLOB_NAMESPACE_ID!,
      prefix: cfg.BLOB_S3_PREFIX,
      requestTimeoutMs: cfg.BLOB_S3_REQUEST_TIMEOUT_MS,
      clientConfig: {
        region: cfg.BLOB_S3_REGION,
        forcePathStyle: cfg.BLOB_S3_FORCE_PATH_STYLE,
        ...(cfg.BLOB_S3_ENDPOINT === undefined ? {} : { endpoint: cfg.BLOB_S3_ENDPOINT }),
        ...(cfg.BLOB_S3_ACCESS_KEY_ID === undefined
          ? {}
          : {
              credentials: {
                accessKeyId: cfg.BLOB_S3_ACCESS_KEY_ID,
                secretAccessKey: cfg.BLOB_S3_SECRET_ACCESS_KEY!,
                ...(cfg.BLOB_S3_SESSION_TOKEN === undefined
                  ? {}
                  : { sessionToken: cfg.BLOB_S3_SESSION_TOKEN }),
              },
            }),
      },
    })
    : new FsBlobStore(cfg.BLOB_DIR);
  const activeBlobStorage = cfg.blobStorage;
  let blobStorageControlGeneration: 0 | 1;
  try {
    if (blobStore instanceof S3BlobStore) {
      await blobStore.validateStartup();
    }
    if (blobStore instanceof S3BlobStore) {
      if (!activeBlobStorage || !cfg.BLOB_STORAGE_CONTROL_ENABLED) {
        throw new Error("shared Blob storage requires an acknowledged durable control");
      }
    }
    blobStorageControlGeneration = await reconcileBlobStorageControlForRuntime(
      store,
      activeBlobStorage,
      async () => {
        if (cfg.STORE === "mysql") {
          await assertBlobStorageMigrationRuntimeReady(cfg.MYSQL_URL);
        }
      },
    );
  } catch (error) {
    await Promise.all([
      blobStore instanceof S3BlobStore ? blobStore.close() : undefined,
      tenantRedisPurgeAdapter?.close(),
      bus.close(),
      lease.close(),
      store.close(),
    ]);
    throw error;
  }
  let tenantBackupCatalogControl: Awaited<
    ReturnType<TenantBackupCatalogStore["getTenantBackupCatalogControl"]>
  >;
  let tenantBackupCatalogRuntimeBinding: string | undefined;
  try {
    // Read and bind the durable catalog before bootstrap mutations or any worker can start. The
    // long-running process receives no catalog object-store credentials; this is only a
    // content-free capability proof over the already-active database/runtime lineage.
    tenantBackupCatalogControl = await store.getTenantBackupCatalogControl();
    if (tenantBackupCatalogControl.state === "active") {
      const runtime = await store.getTenantRestoreRuntimeControl();
      if (blobStorageControlGeneration !== 1
        || runtime.state !== "active"
        || runtime.logicalDatabaseNamespaceSha256
          !== tenantBackupCatalogControl.logicalDatabaseNamespaceSha256
        || runtime.controlEvidenceSha256
          !== tenantBackupCatalogControl.journalControlEvidenceSha256) {
        throw new Error("active backup catalog is not bound to the live durable runtime");
      }
      tenantBackupCatalogRuntimeBinding = tenantBackupCatalogRuntimeBindingSha256({
        catalogControlEvidenceSha256: tenantBackupCatalogControl.evidenceSha256,
        catalogNamespaceSha256: tenantBackupCatalogControl.catalogNamespaceSha256,
        catalogTargetSha256: tenantBackupCatalogControl.catalogTargetSha256,
        logicalDatabaseNamespaceSha256:
          tenantBackupCatalogControl.logicalDatabaseNamespaceSha256,
        journalControlEvidenceSha256:
          tenantBackupCatalogControl.journalControlEvidenceSha256,
        runtimeEpochSha256: runtime.runtimeEpochSha256,
        runtimeControlGeneration: runtime.controlGeneration,
        runtimeControlEvidenceSha256: runtime.evidenceSha256,
        runtimeHeadRootSha256: runtime.verifiedHeadRootSha256,
      });
    }
  } catch (error) {
    await Promise.all([
      closeTenantRestoreJournal(),
      blobStore instanceof S3BlobStore ? blobStore.close() : undefined,
      tenantRedisPurgeAdapter?.close(),
      bus.close(),
      lease.close(),
      store.close(),
    ]);
    throw error;
  }
  const blobs = new SessionBlobService(store, blobStore, {
    maxBlobBytes: cfg.BLOB_MAX_BYTES,
    maxHydratedBytes: cfg.BLOB_MAX_HYDRATED_BYTES,
    stagingTtlMs: cfg.BLOB_STAGING_TTL_MS,
  });

  try {
    if (cfg.BOOTSTRAP_API_KEY) {
      const state = await store.getTenantRuntimeState(cfg.BOOTSTRAP_TENANT_ID);
      if (state.state !== "active") {
        emitRunnerTelemetryEvent("runner.bootstrap.dev_key_skipped");
      } else {
        try {
          await store.createApiKey(
            cfg.BOOTSTRAP_TENANT_ID,
            "bootstrap",
            hashApiKey(cfg.BOOTSTRAP_API_KEY),
            ["runtime", "admin"],
          );
          emitRunnerTelemetryEvent("runner.bootstrap.dev_key_seeded");
        } catch (error) {
          if (!(error instanceof SubjectDeletingError)) throw error;
          emitRunnerTelemetryEvent("runner.bootstrap.dev_key_skipped");
        }
      }
    } else if (cfg.ADMIN_BOOTSTRAP_TENANT) {
      const state = await store.getTenantRuntimeState(cfg.ADMIN_BOOTSTRAP_TENANT);
      if (state.state !== "active") {
        emitRunnerTelemetryEvent("runner.bootstrap.admin_key_inactive");
      } else {
        const keys = await store.listApiKeys(cfg.ADMIN_BOOTSTRAP_TENANT);
        if (keys.some((key) => !key.revokedAtMs && key.scopes.includes("admin"))) {
          emitRunnerTelemetryEvent("runner.bootstrap.admin_key_present");
        } else {
          const key = generateApiKey();
          try {
            await writeAdminBootstrapOutputFile(cfg.ADMIN_BOOTSTRAP_OUTPUT_FILE!, key);
          } catch {
            emitRunnerTelemetryEvent("runner.bootstrap.admin_key_output_rejected");
            throw new Error("admin bootstrap output file could not be created safely");
          }
          try {
            await store.createApiKey(
              cfg.ADMIN_BOOTSTRAP_TENANT,
              `admin-${Date.now()}`,
              hashApiKey(key),
              ["runtime", "admin"],
            );
          } catch (error) {
            emitRunnerTelemetryEvent("runner.bootstrap.admin_key_store_failed");
            if (error instanceof SubjectDeletingError) {
              throw new Error("admin bootstrap tenant became inactive after output reservation");
            }
            throw new Error("admin bootstrap store write failed after output reservation");
          }
          emitRunnerTelemetryEvent("runner.bootstrap.admin_key_written");
        }
      }
    }
  } catch (error) {
    await Promise.all([
      closeTenantRestoreJournal(),
      blobStore instanceof S3BlobStore ? blobStore.close() : undefined,
      tenantRedisPurgeAdapter?.close(),
      bus.close(),
      lease.close(),
      store.close(),
    ]);
    throw error;
  }

  try {
    tenantTelemetryWriterRuntime = await reconcileTenantTelemetryWriterForStartup(
      store,
      cfg,
      runnerRuntimeLogger,
      persistedProviderCaptureGate ? {
        requireFreshFleet: (expected, boundary) => persistedProviderCaptureGate.requireFreshFleet(expected, boundary),
      } : undefined,
    );
  } catch (error) {
    await Promise.all([
      closeTenantRestoreJournal(),
      blobStore instanceof S3BlobStore ? blobStore.close() : undefined,
      tenantRedisPurgeAdapter?.close(),
      bus.close(),
      lease.close(),
      store.close(),
    ]);
    throw error;
  }

  if (tenantTelemetryRefKey !== undefined && tenantTelemetryWriterRuntime.persistedCaptureActive !== true) {
    providerTenantTelemetry = createTenantTelemetryApplicationDualWrite({
      component: "provider",
      producerProtocol: TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL,
      producerContractSha256: TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256,
      opaqueRefKey: tenantTelemetryRefKey,
      processSink: consoleTelemetrySink(),
      store,
      durableEnabled: () => tenantTelemetryWriterRuntime?.captureActive === true,
    });
    if (tenantTelemetryWriterRuntime.active) {
      tenantTelemetryRetryTimer = setInterval(() => {
        if (providerTenantTelemetry!.failedCount > 0) {
          void providerTenantTelemetry!.retryFailed();
        }
      }, cfg.TENANT_TELEMETRY_WRITER_POLL_MS);
      tenantTelemetryRetryTimer.unref?.();
    }
  }

  const platform = [];
  if (cfg.API_KEY) {
    const preset = PROVIDER_PRESETS[cfg.PLATFORM_PROVIDER];
    if (!preset) throw new Error(`unknown PLATFORM_PROVIDER ${cfg.PLATFORM_PROVIDER}`);
    const config = { ...preset, baseUrl: cfg.API_BASE_URL ?? preset.baseUrl };
    if (cfg.DEFAULT_MODEL && !config.models.some((m) => m.id === cfg.DEFAULT_MODEL)) {
      config.models = [{ id: cfg.DEFAULT_MODEL, contextWindow: 128_000, maxOutputTokens: 8192, input: ["text"], reasoning: false }, ...config.models];
    }
    platform.push({ config, apiKey: cfg.API_KEY });
  }
  const cipher = new LocalAesGcmCipher(cfg.SECRETS_MASTER_KEY);
  const credentialTargetExecutionState = cfg.CREDENTIAL_TARGET_EXECUTION_ADAPTER === "fake"
    ? createFakeCredentialTargetExecutionAdapterState()
    : undefined;
  const credentialTargetExecutionAdapter = credentialTargetExecutionState
    ? new FakeCredentialTargetExecutionAdapter(credentialTargetExecutionState)
    : undefined;
  const credentialTargetReferenceCapture = credentialTargetExecutionAdapter
    ? createLocalFakeCredentialTargetReferenceCapture(cfg.SECRETS_MASTER_KEY)
    : undefined;
  const tenantRuntime = new TenantRuntimeCoordinator();
  const providers = new ProviderService({
    store,
    cipher,
    platform,
    tenantRuntime,
    persistedProviderFailureCaptureActive: tenantTelemetryWriterRuntime.persistedCaptureActive === true,
    ...(providerTenantTelemetry === undefined
      ? {}
      : {
          telemetry: providerTenantTelemetry.telemetry,
          tenantTelemetry: providerTenantTelemetry,
        }),
    ...(credentialTargetExecutionAdapter && credentialTargetReferenceCapture
      ? {
          credentialTargetReferenceFactory: credentialTargetReferenceCapture.factory,
          credentialTargetReferenceProtector: credentialTargetReferenceCapture.protector,
        }
      : {}),
  });
  const tools = new StaticToolRegistry(builtinTools);
  const mcp = cfg.mcp.enabled ? new ConfiguredMcpToolSource({
    servers: cfg.mcp.servers, timeoutMs: cfg.mcp.timeoutMs,
    maxConcurrentPerUser: cfg.mcp.maxConcurrentPerUser,
    allowLoopbackForTests: cfg.mcp.allowLoopbackForTests,
    tenantRuntime,
    authorizeSubject: async (principal) => {
      const tenant = await store.getTenantRuntimeState(principal.tenantId);
      const user = await store.getSubjectLifecycle(principal.tenantId, "user", principal.userId);
      if (tenant.state !== "active" || (user && user.state !== "active")) {
        throw new SubjectDeletingError(principal.tenantId, principal.userId);
      }
    },
  }) : undefined;
  skills = cfg.skills.enabled ? new ConfiguredStaticSkillSource({
    skills: cfg.skills.skills,
    tenantRuntime,
    authorizeSubject: async (principal) => {
      // The source supplies the exact mounted/session owner, never the trusted caller that may
      // have created a delegated session. Recheck both tenant T1 and canonical user lifecycle.
      const tenant = await store.getTenantRuntimeState(principal.tenantId);
      const user = await store.getSubjectLifecycle(principal.tenantId, "user", principal.userId);
      if (tenant.state !== "active" || (user && user.state !== "active")) {
        throw new SubjectDeletingError(principal.tenantId, principal.userId);
      }
    },
  }) : undefined;
  closeHookBootstrapResources = async () => {
    await Promise.allSettled([store.close(), lease.close(), bus.close(), tenantRedisPurgeAdapter?.close(),
      blobStore instanceof S3BlobStore ? blobStore.close() : undefined]);
  };
  try {
    hooks = await createConfiguredToolHooks(cfg.hooks, { tenantRuntime, authorizeSubject: async (principal) => {
      const tenant = await store.getTenantRuntimeState(principal.tenantId);
      const user = await store.getSubjectLifecycle(principal.tenantId, "user", principal.userId);
      if (tenant.state !== "active" || user && user.state !== "active") {
        throw new SubjectDeletingError(principal.tenantId, principal.userId);
      }
    } });
  } catch (error) {
    hooksInitializationFailed = true;
    await mcp?.close();
    throw error;
  }
  const host = new SessionHost({
    store, erasureStore: store, lease, bus, providers, tools, mcp, skills, hooks, blobs, tenantRuntime,
    logger: runnerRuntimeLogger,
    onOwnershipLost: () => emitRunnerTelemetryEvent("runner.runtime.ownership_lost"),
    ...(tenantTelemetryWriterRuntime.persistedCaptureActive === true && persistedProviderCaptureGate && tenantTelemetryRefKey ? {
      persistedProviderFailureCapture: createPersistedProviderFailureCapture({
        store, opaqueRefKey: tenantTelemetryRefKey,
        requireFreshFleet: (expected, boundary) => persistedProviderCaptureGate.requireFreshFleet(expected, boundary),
      }),
    } : {}),
    engine: new PiEngine(providers.models),
    summariser: new PiSummariser(providers.models),
    config: {
      runnerId: cfg.RUNNER_ID,
      runnerAddr: cfg.runnerAddr,
      leaseTtlMs: cfg.LEASE_TTL_MS,
      leaseHoldMs: cfg.LEASE_HOLD_MS,
      approvalTtlMs: cfg.APPROVAL_TTL_MS,
      blobAttachmentsEnabled: cfg.BLOB_ATTACHMENTS_ENABLED,
      toolOutputBlobThresholdBytes: cfg.BLOB_TOOL_OUTPUT_THRESHOLD_BYTES,
      maxDurableToolOutputBytes: cfg.BLOB_MAX_BYTES,
      erasureDrainTimeoutMs: cfg.ERASURE_DRAIN_TIMEOUT_MS,
    },
  });
  const lifecycleOutbox = new LifecycleOutboxDispatcher({
    store, bus, logger: runnerRuntimeLogger,
  }, {
    pollIntervalMs: cfg.LIFECYCLE_OUTBOX_POLL_MS,
    leaseMs: cfg.LIFECYCLE_OUTBOX_LEASE_MS,
    batchSize: cfg.LIFECYCLE_OUTBOX_BATCH_SIZE,
    retryBaseMs: cfg.LIFECYCLE_OUTBOX_RETRY_BASE_MS,
    retryMaxMs: cfg.LIFECYCLE_OUTBOX_RETRY_MAX_MS,
  });
  lifecycleOutbox.start();
  const blobCleanup = new BlobCleanupWorker({
    store, blob: blobStore, logger: runnerRuntimeLogger,
  }, {
    pollIntervalMs: cfg.BLOB_CLEANUP_POLL_MS,
    leaseMs: cfg.BLOB_CLEANUP_LEASE_MS,
    batchSize: cfg.BLOB_CLEANUP_BATCH_SIZE,
    retryBaseMs: cfg.BLOB_CLEANUP_RETRY_BASE_MS,
    retryMaxMs: cfg.BLOB_CLEANUP_RETRY_MAX_MS,
    poisonMaxAttempts: cfg.BLOB_CLEANUP_POISON_MAX_ATTEMPTS,
  });
  if (cfg.BLOB_CLEANUP_ENABLED) blobCleanup.start();
  const erasureExecutor = (cfg.ERASURE_WORKER_ENABLED || cfg.LEGACY_TOMBSTONE_COMPENSATION_ENABLED)
    ? new RouterErasureSessionExecutor({
      routerBaseUrl: cfg.ERASURE_ROUTER_URL!,
      internalToken: cfg.INTERNAL_ROUTER_TOKEN,
      requestTimeoutMs: cfg.ERASURE_WORKER_REQUEST_TIMEOUT_MS,
    })
    : undefined;
  const erasureWorker = erasureExecutor
    && cfg.ERASURE_WORKER_ENABLED
    ? new ErasureWorker({
      jobs: store,
      catalog: store,
      usage: store,
      legacyTombstones: store,
      executor: erasureExecutor,
      canClaim: () => erasureExecutor.canClaimErasureJobs(),
      logger: runnerRuntimeLogger,
    }, {
      pollIntervalMs: cfg.ERASURE_WORKER_POLL_MS,
      leaseMs: cfg.ERASURE_WORKER_LEASE_MS,
      jobBatchSize: cfg.ERASURE_WORKER_BATCH_SIZE,
      sessionPageSize: cfg.ERASURE_WORKER_SESSION_PAGE_SIZE,
      retryBaseMs: cfg.ERASURE_WORKER_RETRY_BASE_MS,
      retryMaxMs: cfg.ERASURE_WORKER_RETRY_MAX_MS,
    })
    : undefined;
  const legacyTombstoneCompensationWorker = erasureExecutor
    && cfg.LEGACY_TOMBSTONE_COMPENSATION_ENABLED
    ? new LegacyTombstoneCompensationWorker({
      store,
      canClaim: () => erasureExecutor.canClaimErasureJobs(),
      logger: runnerRuntimeLogger,
    }, {
      pollIntervalMs: cfg.LEGACY_TOMBSTONE_COMPENSATION_POLL_MS,
      leaseMs: cfg.LEGACY_TOMBSTONE_COMPENSATION_LEASE_MS,
      batchSize: cfg.LEGACY_TOMBSTONE_COMPENSATION_BATCH_SIZE,
      retryBaseMs: cfg.LEGACY_TOMBSTONE_COMPENSATION_RETRY_BASE_MS,
      retryMaxMs: cfg.LEGACY_TOMBSTONE_COMPENSATION_RETRY_MAX_MS,
    })
    : undefined;
  const purgePolicyEvaluationGate = cfg.PURGE_POLICY_EVALUATOR_ENABLED
    ? new RouterPurgePolicyEvaluationGate({
      routerBaseUrl: cfg.ERASURE_ROUTER_URL!,
      internalToken: cfg.INTERNAL_ROUTER_TOKEN,
      requestTimeoutMs: cfg.ERASURE_WORKER_REQUEST_TIMEOUT_MS,
    })
    : undefined;
  const purgePolicyEvaluator = purgePolicyEvaluationGate
    ? new PurgePolicyEvaluator({
      store,
      canClaim: () => purgePolicyEvaluationGate.canClaim(),
      logger: runnerRuntimeLogger,
    }, {
      pollIntervalMs: cfg.PURGE_POLICY_EVALUATOR_POLL_MS,
      leaseMs: cfg.PURGE_POLICY_EVALUATOR_LEASE_MS,
      jobBatchSize: cfg.PURGE_POLICY_EVALUATOR_BATCH_SIZE,
      targetPageSize: cfg.PURGE_POLICY_EVALUATOR_TARGET_PAGE_SIZE,
      retryBaseMs: cfg.PURGE_POLICY_EVALUATOR_RETRY_BASE_MS,
      retryMaxMs: cfg.PURGE_POLICY_EVALUATOR_RETRY_MAX_MS,
    })
    : undefined;
  const dataExportWorker = cfg.DATA_EXPORT_WORKER_ENABLED
    ? new UserDataExportWorker({
      store, blob: blobStore, logger: runnerRuntimeLogger,
    }, {
      pollIntervalMs: cfg.DATA_EXPORT_WORKER_POLL_MS,
      leaseMs: cfg.DATA_EXPORT_WORKER_LEASE_MS,
      batchSize: cfg.DATA_EXPORT_WORKER_BATCH_SIZE,
      snapshotPageSize: cfg.DATA_EXPORT_SNAPSHOT_PAGE_SIZE,
      artifactStagingTtlMs: cfg.DATA_EXPORT_ARTIFACT_STAGING_TTL_MS,
      maxSourceBlobBytes: cfg.BLOB_MAX_BYTES,
      retryBaseMs: cfg.DATA_EXPORT_WORKER_RETRY_BASE_MS,
      retryMaxMs: cfg.DATA_EXPORT_WORKER_RETRY_MAX_MS,
      poisonMaxAttempts: cfg.DATA_EXPORT_WORKER_POISON_MAX_ATTEMPTS,
    })
    : undefined;
  const dataExportCleanup = cfg.DATA_EXPORT_CLEANUP_ENABLED
    ? new UserDataExportCleanupWorker({
      store, blob: blobStore, logger: runnerRuntimeLogger,
    }, {
      pollIntervalMs: cfg.DATA_EXPORT_CLEANUP_POLL_MS,
      leaseMs: cfg.DATA_EXPORT_CLEANUP_LEASE_MS,
      batchSize: cfg.DATA_EXPORT_CLEANUP_BATCH_SIZE,
      retryBaseMs: cfg.DATA_EXPORT_CLEANUP_RETRY_BASE_MS,
      retryMaxMs: cfg.DATA_EXPORT_CLEANUP_RETRY_MAX_MS,
      poisonMaxAttempts: cfg.DATA_EXPORT_CLEANUP_POISON_MAX_ATTEMPTS,
    })
    : undefined;
  const tenantErasureAdmissionGate = cfg.TENANT_ERASURE_REQUESTS_ENABLED
    ? new RouterTenantErasureAdmissionGate({
      routerBaseUrl: cfg.ERASURE_ROUTER_URL!,
      internalToken: cfg.INTERNAL_ROUTER_TOKEN,
      requestTimeoutMs: cfg.TENANT_ERASURE_BARRIER_TIMEOUT_MS,
    })
    : undefined;
  const tenantCredentialRevocationGate = cfg.TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED
    ? new RouterTenantCredentialRevocationGate({
      routerBaseUrl: cfg.ERASURE_ROUTER_URL!,
      internalToken: cfg.INTERNAL_ROUTER_TOKEN,
      requestTimeoutMs: cfg.TENANT_ERASURE_BARRIER_TIMEOUT_MS,
    })
    : undefined;
  const tenantCredentialRevocationWorker = tenantCredentialRevocationGate
    ? new TenantCredentialRevocationWorker({
      store,
      canExecute: () => tenantCredentialRevocationGate.canExecute(),
      logger: runnerRuntimeLogger,
    })
    : undefined;
  const tenantCredentialTargetExecutionGate =
    cfg.TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED
      ? new RouterTenantCredentialTargetExecutionGate({
          routerBaseUrl: cfg.ERASURE_ROUTER_URL!,
          internalToken: cfg.INTERNAL_ROUTER_TOKEN,
          requestTimeoutMs: cfg.TENANT_ERASURE_BARRIER_TIMEOUT_MS,
        })
      : undefined;
  const tenantCredentialTargetExecutionWorker =
    tenantCredentialTargetExecutionGate && credentialTargetExecutionAdapter
      ? new TenantCredentialTargetExecutionWorker({
          store,
          adapter: credentialTargetExecutionAdapter,
          canExecute: () => tenantCredentialTargetExecutionGate.canExecute(),
          logger: runnerRuntimeLogger,
        }, {
          pollIntervalMs: cfg.TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_POLL_MS,
          leaseMs: cfg.TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_LEASE_MS,
          batchSize: cfg.TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_BATCH_SIZE,
          materializeBatchSize:
            cfg.TENANT_CREDENTIAL_TARGET_EXECUTION_MATERIALIZE_BATCH_SIZE,
          retryBaseMs: cfg.TENANT_CREDENTIAL_TARGET_EXECUTION_RETRY_BASE_MS,
          retryMaxMs: cfg.TENANT_CREDENTIAL_TARGET_EXECUTION_RETRY_MAX_MS,
        })
      : undefined;
  const tenantRuntimeDrain = new LocalTenantRuntimeDrain(store, tenantRuntime, {
    runnerId: cfg.RUNNER_ID,
    bootId: tenantRuntimeBootId,
    timeoutMs: cfg.TENANT_RUNTIME_DRAIN_TIMEOUT_MS,
  });
  const tenantRuntimeDrainClient = cfg.TENANT_RUNTIME_REVOCATION_WORKER_ENABLED
    ? new RouterTenantRuntimeDrainClient({
      routerBaseUrl: cfg.ERASURE_ROUTER_URL!,
      internalToken: cfg.INTERNAL_ROUTER_TOKEN,
      requestTimeoutMs: cfg.TENANT_RUNTIME_REVOCATION_REQUEST_TIMEOUT_MS,
    })
    : undefined;
  const tenantRuntimeRevocationWorker = tenantRuntimeDrainClient
    ? new TenantRuntimeRevocationWorker({
      store,
      drainFleet: (request) => tenantRuntimeDrainClient.drain(request),
      logger: runnerRuntimeLogger,
    }, {
      pollIntervalMs: cfg.TENANT_RUNTIME_REVOCATION_WORKER_POLL_MS,
      leaseMs: cfg.TENANT_RUNTIME_REVOCATION_WORKER_LEASE_MS,
      batchSize: cfg.TENANT_RUNTIME_REVOCATION_WORKER_BATCH_SIZE,
      materializeBatchSize: cfg.TENANT_RUNTIME_REVOCATION_MATERIALIZE_BATCH_SIZE,
      retryBaseMs: cfg.TENANT_RUNTIME_REVOCATION_RETRY_BASE_MS,
      retryMaxMs: cfg.TENANT_RUNTIME_REVOCATION_RETRY_MAX_MS,
    })
    : undefined;
  const tenantContentInventoryWorker = cfg.TENANT_CONTENT_INVENTORY_WORKER_ENABLED
    ? new TenantContentInventoryWorker({ store, logger: runnerRuntimeLogger }, {
      pollIntervalMs: cfg.TENANT_CONTENT_INVENTORY_WORKER_POLL_MS,
      leaseMs: cfg.TENANT_CONTENT_INVENTORY_WORKER_LEASE_MS,
      batchSize: cfg.TENANT_CONTENT_INVENTORY_WORKER_BATCH_SIZE,
      materializeBatchSize: cfg.TENANT_CONTENT_INVENTORY_MATERIALIZE_BATCH_SIZE,
      sessionPageSize: cfg.TENANT_CONTENT_INVENTORY_SESSION_PAGE_SIZE,
      retryBaseMs: cfg.TENANT_CONTENT_INVENTORY_RETRY_BASE_MS,
      retryMaxMs: cfg.TENANT_CONTENT_INVENTORY_RETRY_MAX_MS,
    })
    : undefined;
  const tenantPurgePlanWorker = cfg.TENANT_PURGE_PLAN_WORKER_ENABLED
    ? new TenantPurgePlanWorker({ store, logger: runnerRuntimeLogger }, {
      pollIntervalMs: cfg.TENANT_PURGE_PLAN_WORKER_POLL_MS,
      leaseMs: cfg.TENANT_PURGE_PLAN_WORKER_LEASE_MS,
      batchSize: cfg.TENANT_PURGE_PLAN_WORKER_BATCH_SIZE,
      materializeBatchSize: cfg.TENANT_PURGE_PLAN_MATERIALIZE_BATCH_SIZE,
      retryBaseMs: cfg.TENANT_PURGE_PLAN_RETRY_BASE_MS,
      retryMaxMs: cfg.TENANT_PURGE_PLAN_RETRY_MAX_MS,
    })
    : undefined;
  const tenantPurgeExecutionGate = cfg.TENANT_PURGE_EXECUTION_WORKER_ENABLED
    ? new RouterTenantPurgeExecutionGate({
      routerBaseUrl: cfg.ERASURE_ROUTER_URL!,
      internalToken: cfg.INTERNAL_ROUTER_TOKEN,
      requestTimeoutMs: cfg.TENANT_ERASURE_BARRIER_TIMEOUT_MS,
    })
    : undefined;
  const tenantPurgeExecutionWorker = tenantPurgeExecutionGate
    ? new TenantPurgeExecutionWorker({
      store,
      canExecute: () => tenantPurgeExecutionGate.canExecute(),
      logger: runnerRuntimeLogger,
    }, {
      pollIntervalMs: cfg.TENANT_PURGE_EXECUTION_WORKER_POLL_MS,
      leaseMs: cfg.TENANT_PURGE_EXECUTION_WORKER_LEASE_MS,
      batchSize: cfg.TENANT_PURGE_EXECUTION_WORKER_BATCH_SIZE,
      materializeBatchSize: cfg.TENANT_PURGE_EXECUTION_MATERIALIZE_BATCH_SIZE,
      retryBaseMs: cfg.TENANT_PURGE_EXECUTION_RETRY_BASE_MS,
      retryMaxMs: cfg.TENANT_PURGE_EXECUTION_RETRY_MAX_MS,
    })
    : undefined;
  const tenantDatabasePurgeGate = cfg.TENANT_DATABASE_PURGE_WORKER_ENABLED
    ? new RouterTenantDatabasePurgeGate({
      routerBaseUrl: cfg.ERASURE_ROUTER_URL!,
      internalToken: cfg.INTERNAL_ROUTER_TOKEN,
      requestTimeoutMs: cfg.TENANT_ERASURE_BARRIER_TIMEOUT_MS,
    })
    : undefined;
  const tenantDatabasePurgeWorker = tenantDatabasePurgeGate
    ? new TenantDatabasePurgeWorker({
      store,
      canExecute: () => tenantDatabasePurgeGate.canExecute(),
      logger: runnerRuntimeLogger,
    }, {
      pollIntervalMs: cfg.TENANT_DATABASE_PURGE_WORKER_POLL_MS,
      leaseMs: cfg.TENANT_DATABASE_PURGE_WORKER_LEASE_MS,
      batchSize: cfg.TENANT_DATABASE_PURGE_WORKER_BATCH_SIZE,
      materializeBatchSize: cfg.TENANT_DATABASE_PURGE_MATERIALIZE_BATCH_SIZE,
      retryBaseMs: cfg.TENANT_DATABASE_PURGE_RETRY_BASE_MS,
      retryMaxMs: cfg.TENANT_DATABASE_PURGE_RETRY_MAX_MS,
    })
    : undefined;
  ordinarySessionDeleteGraceRecovery = cfg.SESSION_DELETE_GRACE_RECOVERY_ENABLED
    ? new OrdinarySessionDeleteGraceRecovery({ store, logger: runnerRuntimeLogger }, {
      pollIntervalMs: cfg.SESSION_DELETE_GRACE_RECOVERY_POLL_MS,
      batchSize: cfg.SESSION_DELETE_GRACE_RECOVERY_BATCH_SIZE,
    })
    : undefined;
  const ordinarySessionUsageRetentionGate = cfg.SESSION_USAGE_RETENTION_WORKER_ENABLED
    ? new RouterOrdinarySessionUsageRetentionGate({
      routerBaseUrl: cfg.ERASURE_ROUTER_URL!,
      internalToken: cfg.INTERNAL_ROUTER_TOKEN,
      requestTimeoutMs: cfg.TENANT_ERASURE_BARRIER_TIMEOUT_MS,
    }) : undefined;
  ordinarySessionUsageRetentionWorker = ordinarySessionUsageRetentionGate
    ? new OrdinarySessionUsageRetentionWorker({
      store,
      canExecute: () => ordinarySessionUsageRetentionGate.canExecute(),
      logger: runnerRuntimeLogger,
    }, {
      pollIntervalMs: cfg.SESSION_USAGE_RETENTION_WORKER_POLL_MS,
      batchSize: cfg.SESSION_USAGE_RETENTION_WORKER_BATCH_SIZE,
    }) : undefined;
  legacyTombstoneCompensationWorker?.start();
  erasureWorker?.start();
  purgePolicyEvaluator?.start();
  dataExportWorker?.start();
  dataExportCleanup?.start();
  tenantCredentialRevocationWorker?.start();
  tenantRestoreJournalWorker?.start();
  tenantCredentialTargetExecutionWorker?.start();
  tenantContentInventoryWorker?.start();
  tenantPurgePlanWorker?.start();
  tenantPurgeExecutionWorker?.start();
  tenantDatabasePurgeWorker?.start();
  ordinarySessionDeleteGraceRecovery?.start();
  ordinarySessionUsageRetentionWorker?.start();
  tenantRedisPurgeWorker?.start();
  tenantTelemetryWriterRuntime.worker?.start();

  let ready = true;
  const app = createApp({
    store, host, providers, tools, mcpEnabled: mcp?.enabled === true, skillsEnabled: skills?.enabled === true,
    hooksEnabled: hooks?.enabled === true,
    telemetry: runnerProcessTelemetry,
    ...(cfg.METRICS_BEARER_TOKEN === undefined ? {} : {
      metrics: { bearerToken: cfg.METRICS_BEARER_TOKEN,
        ...(cfg.METRICS_ENABLED ? { registry: createRuntimeMetrics("runner") } : {}),
      },
    }),
    runnerId: cfg.RUNNER_ID,
    internalRouterToken: cfg.INTERNAL_ROUTER_TOKEN,
    heartbeatMs: cfg.SSE_HEARTBEAT_MS,
    maxBodyBytes: cfg.MAX_BODY_BYTES,
    blobAttachmentsEnabled: cfg.BLOB_ATTACHMENTS_ENABLED,
    ...(activeBlobStorage === undefined ? {} : { blobStorage: activeBlobStorage }),
    erasureRequestsEnabled: cfg.DATA_ERASURE_REQUESTS_ENABLED,
    legacyTombstoneCompensationEnabled: cfg.LEGACY_TOMBSTONE_COMPENSATION_ENABLED,
    dataGovernanceManagementEnabled: cfg.DATA_GOVERNANCE_MANAGEMENT_ENABLED,
    retentionPolicy: store,
    purgePolicyEvaluationSupported: true,
    ...(cfg.dataExportArtifactsReadable ? {
      userDataExport: store,
      dataExportBlob: blobStore,
    } : {}),
    dataExportRequestsEnabled: cfg.dataExportArtifactsReadable && cfg.DATA_EXPORT_REQUESTS_ENABLED,
    dataExportDownloadLeaseMs: cfg.DATA_EXPORT_DOWNLOAD_LEASE_MS,
    subjectLifecycle: store,
    tenantErasureRequestsEnabled: cfg.TENANT_ERASURE_REQUESTS_ENABLED,
    tenantErasureAdmissionGate,
    tenantCredentialRevocation: store,
    tenantCredentialResponsibility: store,
    tenantCredentialRevocationWorkerEnabled:
      cfg.TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED,
    tenantCredentialLifecycleTrackingActive: async () => (
      (await store.readTenantCredentialTrackingCutover()).controlGeneration === 1
    ),
    tenantCredentialTargetExecutionSupported:
      credentialTargetExecutionAdapter !== undefined,
    tenantCredentialTargetExecutionWorkerEnabled:
      tenantCredentialTargetExecutionWorker !== undefined,
    tenantRestoreJournalSupported: cfg.tenantRestoreJournal !== undefined,
    tenantRestoreJournalWorkerEnabled: tenantRestoreJournalWorker !== undefined,
    tenantRestoreJournalNamespaceSha256:
      cfg.tenantRestoreJournal?.journalNamespaceSha256,
    tenantRestoreJournalTargetRootSha256:
      cfg.tenantRestoreJournal?.targetRootSha256,
    tenantRestoreRuntimeEpochSha256:
      cfg.tenantRestoreJournal?.runtimeEpochSha256,
    tenantBackupCatalogSupported: true,
    tenantBackupCatalogActive: tenantBackupCatalogControl.state === "active",
    ...(tenantBackupCatalogControl.state === "active" ? {
      tenantBackupCatalogNamespaceSha256:
        tenantBackupCatalogControl.catalogNamespaceSha256,
      tenantBackupCatalogTargetSha256: tenantBackupCatalogControl.catalogTargetSha256,
      tenantBackupCatalogRuntimeBindingSha256: tenantBackupCatalogRuntimeBinding!,
    } : {}),
    // Read the durable control on every acknowledgement attempt instead of freezing this decision
    // at process startup. A current binary that was already running during the forward-only
    // dormant -> active cutover must fail closed immediately, even before it is drained/restarted
    // with the publisher. Generation zero preserves the pre-activation response contract.
    tenantRestoreJournalPublicationReady: async (tenantId: string, requestId: string) => {
      const control = await store.getTenantRestoreJournalControl();
      if (control.controlGeneration === 0) return true;
      return (await store.getTenantRestoreJournalPublicationBundle(tenantId, requestId))
        ?.receipt !== undefined;
    },
    tenantPurgeExecutionWorkerEnabled:
      tenantPurgeExecutionWorker !== undefined,
    tenantDatabasePurgeWorkerEnabled:
      tenantDatabasePurgeWorker !== undefined,
    ordinarySessionUsageRetentionSupported: true,
    ordinarySessionUsageRetentionWorkerEnabled: ordinarySessionUsageRetentionWorker !== undefined,
    ...(tenantTelemetryWriterRuntime.persistedCaptureActive === true ? {
      persistedProviderCapture: {
        bootId: tenantRuntimeBootId, localEnabled: cfg.PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED,
        writerEnabled: tenantTelemetryWriterRuntime.worker !== undefined,
        getBinding: () => store.getTenantTelemetryPersistedProviderCaptureBinding(),
      },
    } : {}),
    tenantRedisPurgeSupported: tenantRedisPurgeAdapter !== undefined,
    tenantRedisPurgeWorkerEnabled: tenantRedisPurgeWorker !== undefined,
    tenantRedisPurgeNamespaceSha256: redisNamespaceSha256,
    tenantRuntime,
    tenantRuntimeDrain,
    tenantRuntimeDrainEnabled: cfg.TENANT_RUNTIME_DRAIN_ENABLED,
    maxBlobBytes: cfg.BLOB_MAX_BYTES,
    ready: () => ready && (providerTenantTelemetry?.durableReady ?? true),
    decryptSecret: (s) => cipher.decrypt(s.ciphertext, s.keyId),
    encryptSecret: async (p) => ({ ciphertext: await cipher.encrypt(p), keyId: cipher.keyId }),
  });
  // The local proof is meaningful only when its participant set cannot change after readiness.
  tenantRuntime.sealParticipants();
  const server = serve({ fetch: app.fetch, port: cfg.RUNNER_PORT, hostname: cfg.RUNNER_HOST });
  tenantRuntimeRevocationWorker?.start();

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (_signal: string, exitProcess: boolean): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      emitRunnerTelemetryEvent("runner.lifecycle.draining");
      ready = false;
      // Stop accepting new connections while allowing existing requests/streams to finish during
      // the host drain. Stores stay available until workers and HTTP have both quiesced.
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Revoke both queue authorities together. Stopping these sequentially would leave the
      // second worker able to begin another claim while the first one waits for an in-flight pass.
      await Promise.all([
        erasureWorker?.stop(),
        legacyTombstoneCompensationWorker?.stop(),
        purgePolicyEvaluator?.stop(),
        dataExportWorker?.stop(),
        dataExportCleanup?.stop(),
        tenantCredentialRevocationWorker?.stop(),
        closeTenantRestoreJournal(),
        tenantCredentialTargetExecutionWorker?.stop(),
        tenantRuntimeRevocationWorker?.stop(),
        tenantContentInventoryWorker?.stop(),
        tenantPurgePlanWorker?.stop(),
        tenantPurgeExecutionWorker?.stop(),
        tenantDatabasePurgeWorker?.stop(),
        ordinarySessionDeleteGraceRecovery?.stop(),
        ordinarySessionUsageRetentionWorker?.stop(),
        tenantRedisPurgeWorker?.stop(),
      ]);
      await Promise.all([host.drain(30_000), mcp?.close(), skills?.close(), hooks?.close()]);
      if (tenantTelemetryRetryTimer !== undefined) {
        clearInterval(tenantTelemetryRetryTimer);
        tenantTelemetryRetryTimer = undefined;
      }
      await providerTenantTelemetry?.close();
      await tenantTelemetryWriterRuntime?.worker?.stop();
      await Promise.all([lifecycleOutbox.stop(), blobCleanup.stop()]);

      // `server.close()` deliberately waits for active HTTP connections. A long-lived SSE subscriber
      // (or an upstream keep-alive peer that never finishes closing) can therefore keep a fully
      // drained runner alive forever. Give completed turn responses one short flush window, then
      // terminate only the remaining transport connections; business work has already quiesced.
      if ("closeIdleConnections" in server) server.closeIdleConnections();
      let transportClosed = false;
      void serverClosed.then(() => {
        transportClosed = true;
      });
      let closeGraceTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        serverClosed,
        new Promise<void>((resolve) => {
          closeGraceTimer = setTimeout(resolve, 1_000);
        }),
      ]);
      if (closeGraceTimer) clearTimeout(closeGraceTimer);
      if (!transportClosed && "closeAllConnections" in server) server.closeAllConnections();
      await serverClosed;
      await Promise.all([
        store.close(),
        lease.close(),
        bus.close(),
        tenantRedisPurgeAdapter?.close(),
        blobStore instanceof S3BlobStore ? blobStore.close() : undefined,
      ]);
      if (exitProcess) process.exit(0);
    })();
    return shutdownPromise;
  };
  const onSigterm = () => void shutdown("SIGTERM", true);
  const onSigint = () => void shutdown("SIGINT", true);
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  const gateStates = [
    cfg.BLOB_ATTACHMENTS_ENABLED,
    cfg.BLOB_CLEANUP_ENABLED,
    cfg.DATA_ERASURE_REQUESTS_ENABLED,
    cfg.ERASURE_WORKER_ENABLED,
    cfg.LEGACY_TOMBSTONE_COMPENSATION_ENABLED,
    cfg.TENANT_ERASURE_REQUESTS_ENABLED,
    cfg.CREDENTIAL_LIFECYCLE_TRACKING_ENABLED,
    cfg.TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED,
    tenantRestoreJournalWorker !== undefined,
    cfg.TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED,
    cfg.TENANT_RUNTIME_DRAIN_ENABLED,
    cfg.TENANT_RUNTIME_REVOCATION_WORKER_ENABLED,
    cfg.TENANT_CONTENT_INVENTORY_WORKER_ENABLED,
    cfg.TENANT_PURGE_PLAN_WORKER_ENABLED,
    cfg.TENANT_PURGE_EXECUTION_WORKER_ENABLED,
    cfg.TENANT_DATABASE_PURGE_WORKER_ENABLED,
    cfg.SESSION_DELETE_GRACE_RECOVERY_ENABLED,
    cfg.SESSION_USAGE_RETENTION_WORKER_ENABLED,
    cfg.TENANT_REDIS_PURGE_WORKER_ENABLED,
    cfg.DATA_GOVERNANCE_MANAGEMENT_ENABLED,
    cfg.PURGE_POLICY_EVALUATOR_ENABLED,
    cfg.DATA_EXPORT_REQUESTS_ENABLED,
    cfg.DATA_EXPORT_WORKER_ENABLED,
    cfg.DATA_EXPORT_CLEANUP_ENABLED,
    tenantTelemetryWriterRuntime.worker !== undefined,
    cfg.PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED,
  ];
  const gateEnabledCount = gateStates.filter(Boolean).length;
  emitRunnerTelemetryEvent("runner.lifecycle.started", {
    gateEnabledCount,
    gateDisabledCount: gateStates.length - gateEnabledCount,
  });
  return {
    app, server, host, lifecycleOutbox, blobCleanup, erasureWorker,
    legacyTombstoneCompensationWorker, purgePolicyEvaluator,
    dataExportWorker, dataExportCleanup, tenantErasureAdmissionGate,
    tenantCredentialRevocationGate, tenantCredentialRevocationWorker,
    tenantRestoreJournalGate, tenantRestoreJournalWorker, tenantRestoreJournalPreflight,
    tenantCredentialTargetExecutionGate, tenantCredentialTargetExecutionWorker,
    credentialTargetExecutionAdapter, credentialTargetExecutionState,
    tenantRuntime, tenantRuntimeDrain, tenantRuntimeDrainClient,
    tenantRuntimeRevocationWorker, tenantContentInventoryWorker, tenantPurgePlanWorker,
    tenantPurgeExecutionGate, tenantPurgeExecutionWorker,
    tenantDatabasePurgeGate, tenantDatabasePurgeWorker,
    ordinarySessionDeleteGraceRecovery,
    ordinarySessionUsageRetentionGate, ordinarySessionUsageRetentionWorker,
    tenantRedisPurgeGate, tenantRedisPurgeWorker, tenantRedisPurgeAdapter,
    tenantTelemetryWriterRuntime, providerTenantTelemetry,
    persistedProviderCaptureGate,
    tenantRuntimeBootId,
    blobs, blobStore, store, lease, bus, skills, hooks, cfg,
    close: () => shutdown("close", false),
  };
  } catch (error) {
    await hooks?.close();
    // A new protected hook-key/config failure can happen after store/lease/bus creation,
    // before any listener or later runtime worker exists. Do not leave these owned pools open
    // when an embedding caller catches startup failure instead of exiting the OS process.
    try {
      if (tenantTelemetryRetryTimer !== undefined) clearInterval(tenantTelemetryRetryTimer);
      await skills?.close();
      await ordinarySessionDeleteGraceRecovery?.stop();
      await ordinarySessionUsageRetentionWorker?.stop();
      await providerTenantTelemetry?.close();
      await tenantTelemetryWriterRuntime?.worker?.stop();
      await closeTenantRestoreJournal();
    } finally {
      if (hooksInitializationFailed) await closeHookBootstrapResources?.();
    }
    throw error;
  }
}

if (isDirectCliEntrypoint(import.meta.url)) {
  startRunner().catch(() => {
    emitRunnerTelemetryEvent("runner.process.start_failed");
    process.exit(1);
  });
}
