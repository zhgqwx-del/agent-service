import { serve } from "@hono/node-server";
import {
  BlobCleanupWorker,
  LifecycleOutboxDispatcher,
  PiEngine,
  PiSummariser,
  SessionBlobService,
  SessionHost,
  StaticToolRegistry,
  builtinTools,
} from "@agent-service/core";
import { LocalAesGcmCipher, ProviderService, PROVIDER_PRESETS } from "@agent-service/providers";
import {
  FsBlobStore,
  MemoryEventBus,
  MemoryLeaseStore,
  MemorySessionStore,
  MysqlSessionStore,
  RedisEventBus,
  RedisLeaseStore,
  type BlobCleanupStore,
  type BlobManifestStore,
  type EventBus,
  type LeaseStore,
  type LifecycleOutboxStore,
  type SubjectLifecycleStore,
  type SessionStore,
} from "@agent-service/store";
import { createApp } from "./app.js";
import { generateApiKey, hashApiKey } from "./auth.js";
import { loadConfig } from "./config.js";

export async function startRunner(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadConfig(env);
  const store: SessionStore & LifecycleOutboxStore & BlobManifestStore & BlobCleanupStore & SubjectLifecycleStore = cfg.STORE === "mysql"
    ? await MysqlSessionStore.connect({ url: cfg.MYSQL_URL })
    : new MemorySessionStore();
  const lease: LeaseStore = cfg.REDIS_URL ? new RedisLeaseStore(cfg.REDIS_URL) : new MemoryLeaseStore();
  const bus: EventBus = cfg.REDIS_URL ? new RedisEventBus(cfg.REDIS_URL) : new MemoryEventBus();
  const blobStore = new FsBlobStore(cfg.BLOB_DIR);
  const blobs = new SessionBlobService(store, blobStore, {
    maxBlobBytes: cfg.BLOB_MAX_BYTES,
    maxHydratedBytes: cfg.BLOB_MAX_HYDRATED_BYTES,
    stagingTtlMs: cfg.BLOB_STAGING_TTL_MS,
  });

  if (cfg.BOOTSTRAP_API_KEY) {
    await store.createApiKey(cfg.BOOTSTRAP_TENANT_ID, "bootstrap", hashApiKey(cfg.BOOTSTRAP_API_KEY), ["runtime", "admin"]);
    console.warn(`[runner ${cfg.RUNNER_ID}] seeded bootstrap api key for tenant ${cfg.BOOTSTRAP_TENANT_ID} (dev only)`);
  } else if (cfg.ADMIN_BOOTSTRAP_TENANT) {
    // Production path for a fresh install: mint ONE admin key, print it once, then never again. Without
    // this there is no way to obtain the first admin key except editing the database by hand.
    const keys = await store.listApiKeys(cfg.ADMIN_BOOTSTRAP_TENANT);
    if (keys.some((k) => !k.revokedAtMs && k.scopes.includes("admin"))) {
      console.log(`[runner ${cfg.RUNNER_ID}] tenant ${cfg.ADMIN_BOOTSTRAP_TENANT} already has an admin key; nothing to do`);
    } else {
      const key = generateApiKey();
      await store.createApiKey(cfg.ADMIN_BOOTSTRAP_TENANT, `admin-${Date.now()}`, hashApiKey(key), ["runtime", "admin"]);
      console.log(`[runner ${cfg.RUNNER_ID}] minted the first admin key for ${cfg.ADMIN_BOOTSTRAP_TENANT}. Store it now, it is not recoverable:\n  ${key}`);
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
  const providers = new ProviderService({ store, cipher, platform });
  const tools = new StaticToolRegistry(builtinTools);
  const host = new SessionHost({
    store, lease, bus, providers, tools, blobs,
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

  let ready = true;
  const app = createApp({
    store, host, providers, tools,
    runnerId: cfg.RUNNER_ID,
    internalRouterToken: cfg.INTERNAL_ROUTER_TOKEN,
    heartbeatMs: cfg.SSE_HEARTBEAT_MS,
    maxBodyBytes: cfg.MAX_BODY_BYTES,
    blobAttachmentsEnabled: cfg.BLOB_ATTACHMENTS_ENABLED,
    erasureRequestsEnabled: cfg.DATA_ERASURE_REQUESTS_ENABLED,
    subjectLifecycle: store,
    maxBlobBytes: cfg.BLOB_MAX_BYTES,
    ready: () => ready,
    decryptSecret: (s) => cipher.decrypt(s.ciphertext, s.keyId),
    encryptSecret: async (p) => ({ ciphertext: await cipher.encrypt(p), keyId: cipher.keyId }),
  });
  const server = serve({ fetch: app.fetch, port: cfg.RUNNER_PORT, hostname: cfg.RUNNER_HOST });

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
      await Promise.all([store.close(), lease.close(), bus.close()]);
      if (exitProcess) process.exit(0);
    })();
    return shutdownPromise;
  };
  const onSigterm = () => void shutdown("SIGTERM", true);
  const onSigint = () => void shutdown("SIGINT", true);
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  console.log(`[runner ${cfg.RUNNER_ID}] listening on http://${cfg.RUNNER_HOST}:${cfg.RUNNER_PORT} store=${cfg.STORE} redis=${cfg.REDIS_URL ? "yes" : "memory"} platform=${platform.map((p) => p.config.id).join(",") || "none"} blobWrites=${cfg.BLOB_ATTACHMENTS_ENABLED ? "yes" : "no"} blobCleanup=${cfg.BLOB_CLEANUP_ENABLED ? "yes" : "no"} erasureRequests=${cfg.DATA_ERASURE_REQUESTS_ENABLED ? "enabled" : "gated"}`);
  return {
    app, server, host, lifecycleOutbox, blobCleanup, blobs, blobStore, store, lease, bus, cfg,
    close: () => shutdown("close", false),
  };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  startRunner().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
