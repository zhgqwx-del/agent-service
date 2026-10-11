import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import {
  BlobCleanupWorker,
  createFakeCredentialTargetExecutionAdapterState,
  ErasureWorker,
  FakeCredentialTargetExecutionAdapter,
  LegacyTombstoneCompensationWorker,
  LifecycleOutboxDispatcher,
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
  TenantPurgeExecutionWorker,
  TenantPurgePlanWorker,
  TenantRuntimeCoordinator,
  TenantRuntimeRevocationWorker,
  UserDataExportCleanupWorker,
  UserDataExportWorker,
  builtinTools,
} from "@agent-service/core";
import { tenantRedisNamespaceSha256 } from "@agent-service/protocol";
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
  type TenantCredentialTargetExecutionStore,
  type TenantBackupCatalogStore,
  type TenantDatabasePurgeStore,
  type TenantRedisPurgeStore,
  type TenantRestoreJournalStore,
  type TenantContentInventoryStore,
  type TenantPurgeExecutionStore,
  type TenantPurgePlanStore,
  type TenantRuntimeRevocationStore,
  type SessionStore,
  type UsageLifecycleStore,
  type UserDataExportCleanupStore,
  type UserDataExportJobStore,
  type UserDataExportRequestStore,
} from "@agent-service/store";
import { createApp } from "./app.js";
import { generateApiKey, hashApiKey } from "./auth.js";
import { createLocalFakeCredentialTargetReferenceCapture } from
  "./credential-target-reference-local.js";
import { reconcileBlobStorageControlForRuntime } from "./blob-storage-control.js";
import { assertBlobStorageMigrationRuntimeReady } from "./blob-storage-migration-gate.js";
import { loadConfig } from "./config.js";
import { RouterErasureSessionExecutor } from "./erasure-executor.js";
import { RouterPurgePolicyEvaluationGate } from "./purge-policy-evaluation-gate.js";
import { RouterTenantErasureAdmissionGate } from "./tenant-erasure-admission-gate.js";
import { RouterTenantCredentialRevocationGate } from "./tenant-credential-revocation-gate.js";
import { RouterTenantCredentialTargetExecutionGate } from "./tenant-credential-target-execution-gate.js";
import { RouterTenantDatabasePurgeGate } from "./tenant-database-purge-gate.js";
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

export async function startRunner(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadConfig(env);
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
    & ErasureSessionStore
    & UserDataExportRequestStore
    & UserDataExportJobStore
    & UserDataExportCleanupStore = cfg.STORE === "mysql"
    ? await MysqlSessionStore.connect({
      url: cfg.MYSQL_URL,
      ...(redisNamespaceSha256 === undefined
        ? {}
        : { tenantRedisPurgeNamespaceSha256: redisNamespaceSha256 }),
    })
    : new MemorySessionStore();

  let tenantRestoreJournalWorker: TenantRestoreJournalPublicationWorker | undefined;
  let tenantRestoreJournalGate: RouterTenantRestoreJournalGate | undefined;
  let tenantRestoreJournalPreflight: TenantRestoreJournalPreflightSummary | undefined;
  let tenantRestoreJournalAdapters: ReturnType<typeof createTenantRestoreJournalAdapters> = [];
  let tenantRestoreJournalClosePromise: Promise<void> | undefined;
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

  if (cfg.BOOTSTRAP_API_KEY) {
    const state = await store.getTenantRuntimeState(cfg.BOOTSTRAP_TENANT_ID);
    if (state.state !== "active") {
      console.warn(`[runner ${cfg.RUNNER_ID}] skipped bootstrap api key for inactive tenant ${cfg.BOOTSTRAP_TENANT_ID}`);
    } else {
      try {
        await store.createApiKey(cfg.BOOTSTRAP_TENANT_ID, "bootstrap", hashApiKey(cfg.BOOTSTRAP_API_KEY), ["runtime", "admin"]);
        console.warn(`[runner ${cfg.RUNNER_ID}] seeded bootstrap api key for tenant ${cfg.BOOTSTRAP_TENANT_ID} (dev only)`);
      } catch (error) {
        if (!(error instanceof SubjectDeletingError)) throw error;
        console.warn(`[runner ${cfg.RUNNER_ID}] skipped bootstrap api key for inactive tenant ${cfg.BOOTSTRAP_TENANT_ID}`);
      }
    }
  } else if (cfg.ADMIN_BOOTSTRAP_TENANT) {
    // Production path for a fresh install: mint ONE admin key, print it once, then never again. Without
    // this there is no way to obtain the first admin key except editing the database by hand.
    const state = await store.getTenantRuntimeState(cfg.ADMIN_BOOTSTRAP_TENANT);
    if (state.state !== "active") {
      console.warn(`[runner ${cfg.RUNNER_ID}] skipped first admin key for inactive tenant ${cfg.ADMIN_BOOTSTRAP_TENANT}`);
    } else {
      const keys = await store.listApiKeys(cfg.ADMIN_BOOTSTRAP_TENANT);
      if (keys.some((k) => !k.revokedAtMs && k.scopes.includes("admin"))) {
        console.log(`[runner ${cfg.RUNNER_ID}] tenant ${cfg.ADMIN_BOOTSTRAP_TENANT} already has an admin key; nothing to do`);
      } else {
        const key = generateApiKey();
        try {
          await store.createApiKey(cfg.ADMIN_BOOTSTRAP_TENANT, `admin-${Date.now()}`, hashApiKey(key), ["runtime", "admin"]);
          console.log(`[runner ${cfg.RUNNER_ID}] minted the first admin key for ${cfg.ADMIN_BOOTSTRAP_TENANT}. Store it now, it is not recoverable:\n  ${key}`);
        } catch (error) {
          if (!(error instanceof SubjectDeletingError)) throw error;
          console.warn(`[runner ${cfg.RUNNER_ID}] skipped first admin key for inactive tenant ${cfg.ADMIN_BOOTSTRAP_TENANT}`);
        }
      }
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
    ...(credentialTargetExecutionAdapter && credentialTargetReferenceCapture
      ? {
          credentialTargetReferenceFactory: credentialTargetReferenceCapture.factory,
          credentialTargetReferenceProtector: credentialTargetReferenceCapture.protector,
        }
      : {}),
  });
  const tools = new StaticToolRegistry(builtinTools);
  const host = new SessionHost({
    store, erasureStore: store, lease, bus, providers, tools, blobs, tenantRuntime,
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
  const lifecycleOutbox = new LifecycleOutboxDispatcher({ store, bus }, {
    pollIntervalMs: cfg.LIFECYCLE_OUTBOX_POLL_MS,
    leaseMs: cfg.LIFECYCLE_OUTBOX_LEASE_MS,
    batchSize: cfg.LIFECYCLE_OUTBOX_BATCH_SIZE,
    retryBaseMs: cfg.LIFECYCLE_OUTBOX_RETRY_BASE_MS,
    retryMaxMs: cfg.LIFECYCLE_OUTBOX_RETRY_MAX_MS,
  });
  lifecycleOutbox.start();
  const blobCleanup = new BlobCleanupWorker({ store, blob: blobStore }, {
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
    ? new UserDataExportWorker({ store, blob: blobStore }, {
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
    ? new UserDataExportCleanupWorker({ store, blob: blobStore }, {
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
  const tenantRuntimeBootId = randomUUID();
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
    ? new TenantContentInventoryWorker({ store }, {
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
    ? new TenantPurgePlanWorker({ store }, {
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
    }, {
      pollIntervalMs: cfg.TENANT_DATABASE_PURGE_WORKER_POLL_MS,
      leaseMs: cfg.TENANT_DATABASE_PURGE_WORKER_LEASE_MS,
      batchSize: cfg.TENANT_DATABASE_PURGE_WORKER_BATCH_SIZE,
      materializeBatchSize: cfg.TENANT_DATABASE_PURGE_MATERIALIZE_BATCH_SIZE,
      retryBaseMs: cfg.TENANT_DATABASE_PURGE_RETRY_BASE_MS,
      retryMaxMs: cfg.TENANT_DATABASE_PURGE_RETRY_MAX_MS,
    })
    : undefined;
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
  tenantRedisPurgeWorker?.start();

  let ready = true;
  const app = createApp({
    store, host, providers, tools,
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
    tenantRedisPurgeSupported: tenantRedisPurgeAdapter !== undefined,
    tenantRedisPurgeWorkerEnabled: tenantRedisPurgeWorker !== undefined,
    tenantRedisPurgeNamespaceSha256: redisNamespaceSha256,
    tenantRuntime,
    tenantRuntimeDrain,
    tenantRuntimeDrainEnabled: cfg.TENANT_RUNTIME_DRAIN_ENABLED,
    maxBlobBytes: cfg.BLOB_MAX_BYTES,
    ready: () => ready,
    decryptSecret: (s) => cipher.decrypt(s.ciphertext, s.keyId),
    encryptSecret: async (p) => ({ ciphertext: await cipher.encrypt(p), keyId: cipher.keyId }),
  });
  // The local proof is meaningful only when its participant set cannot change after readiness.
  tenantRuntime.sealParticipants();
  const server = serve({ fetch: app.fetch, port: cfg.RUNNER_PORT, hostname: cfg.RUNNER_HOST });
  tenantRuntimeRevocationWorker?.start();

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string, exitProcess: boolean): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      console.log(`[runner ${cfg.RUNNER_ID}] ${signal}: draining`);
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
        tenantRedisPurgeWorker?.stop(),
      ]);
      await host.drain(30_000);
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

  console.log(`[runner ${cfg.RUNNER_ID}] listening on http://${cfg.RUNNER_HOST}:${cfg.RUNNER_PORT} store=${cfg.STORE} redis=${cfg.REDIS_URL ? "yes" : "memory"} platform=${platform.map((p) => p.config.id).join(",") || "none"} blobStore=${cfg.BLOB_STORE} blobControl=${blobStorageControlGeneration} blobWrites=${cfg.BLOB_ATTACHMENTS_ENABLED ? "yes" : "no"} blobCleanup=${cfg.BLOB_CLEANUP_ENABLED ? "yes" : "no"} erasureRequests=${cfg.DATA_ERASURE_REQUESTS_ENABLED ? "enabled" : "gated"} erasureWorker=${cfg.ERASURE_WORKER_ENABLED ? "yes" : "no"} legacyTombstoneCompensation=${cfg.LEGACY_TOMBSTONE_COMPENSATION_ENABLED ? "yes" : "no"} tenantErasureRequests=${cfg.TENANT_ERASURE_REQUESTS_ENABLED ? "enabled" : "gated"} credentialLifecycleTracking=${cfg.CREDENTIAL_LIFECYCLE_TRACKING_ENABLED ? "enabled" : "gated"} tenantCredentialRevocationWorker=${cfg.TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED ? "yes" : "no"} restoreJournal=${cfg.tenantRestoreJournal ? "configured" : "absent"} restoreJournalWorker=${tenantRestoreJournalWorker ? "yes" : "no"} credentialTargetExecutionWorker=${cfg.TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED ? "yes" : "no"} tenantRuntimeDrain=${cfg.TENANT_RUNTIME_DRAIN_ENABLED ? "enabled" : "gated"} tenantRuntimeRevocationWorker=${cfg.TENANT_RUNTIME_REVOCATION_WORKER_ENABLED ? "yes" : "no"} tenantContentInventoryWorker=${cfg.TENANT_CONTENT_INVENTORY_WORKER_ENABLED ? "yes" : "no"} tenantPurgePlanWorker=${cfg.TENANT_PURGE_PLAN_WORKER_ENABLED ? "yes" : "no"} tenantPurgeExecutionWorker=${cfg.TENANT_PURGE_EXECUTION_WORKER_ENABLED ? "yes" : "no"} tenantDatabasePurgeWorker=${cfg.TENANT_DATABASE_PURGE_WORKER_ENABLED ? "yes" : "no"} tenantRedisPurgeWorker=${cfg.TENANT_REDIS_PURGE_WORKER_ENABLED ? "yes" : "no"} dataGovernance=${cfg.DATA_GOVERNANCE_MANAGEMENT_ENABLED ? "enabled" : "gated"} purgePolicyEvaluator=${cfg.PURGE_POLICY_EVALUATOR_ENABLED ? "yes" : "no"} dataExportRequests=${cfg.DATA_EXPORT_REQUESTS_ENABLED ? "enabled" : "gated"} dataExportWorker=${cfg.DATA_EXPORT_WORKER_ENABLED ? "yes" : "no"} dataExportCleanup=${cfg.DATA_EXPORT_CLEANUP_ENABLED ? "yes" : "no"}`);
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
    tenantRedisPurgeGate, tenantRedisPurgeWorker, tenantRedisPurgeAdapter,
    tenantRuntimeBootId,
    blobs, blobStore, store, lease, bus, cfg,
    close: () => shutdown("close", false),
  };
  } catch (error) {
    await closeTenantRestoreJournal();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  startRunner().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
