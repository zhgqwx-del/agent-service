import { serve } from "@hono/node-server";
import { PiEngine, PiSummariser, SessionHost, StaticToolRegistry, builtinTools } from "@agent-service/core";
import { LocalAesGcmCipher, ProviderService, PROVIDER_PRESETS } from "@agent-service/providers";
import { FsBlobStore, MemoryEventBus, MemoryLeaseStore, MemorySessionStore, MysqlSessionStore, RedisEventBus, RedisLeaseStore, type EventBus, type LeaseStore, type SessionStore } from "@agent-service/store";
import { createApp } from "./app.js";
import { generateApiKey, hashApiKey } from "./auth.js";
import { loadConfig } from "./config.js";

export async function startRunner(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadConfig(env);
  const store: SessionStore = cfg.STORE === "mysql" ? await MysqlSessionStore.connect({ url: cfg.MYSQL_URL }) : new MemorySessionStore();
  const lease: LeaseStore = cfg.REDIS_URL ? new RedisLeaseStore(cfg.REDIS_URL) : new MemoryLeaseStore();
  const bus: EventBus = cfg.REDIS_URL ? new RedisEventBus(cfg.REDIS_URL) : new MemoryEventBus();
  void new FsBlobStore(cfg.BLOB_DIR);

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
    store, lease, bus, providers, tools,
    engine: new PiEngine(providers.models),
    summariser: new PiSummariser(providers.models),
    config: { runnerId: cfg.RUNNER_ID, runnerAddr: cfg.runnerAddr, leaseTtlMs: cfg.LEASE_TTL_MS, leaseHoldMs: cfg.LEASE_HOLD_MS, approvalTtlMs: cfg.APPROVAL_TTL_MS },
  });

  let ready = true;
  const app = createApp({
    store, host, providers, tools,
    runnerId: cfg.RUNNER_ID,
    heartbeatMs: cfg.SSE_HEARTBEAT_MS,
    maxBodyBytes: cfg.MAX_BODY_BYTES,
    ready: () => ready,
    decryptSecret: (s) => cipher.decrypt(s.ciphertext, s.keyId),
    encryptSecret: async (p) => ({ ciphertext: await cipher.encrypt(p), keyId: cipher.keyId }),
  });
  const server = serve({ fetch: app.fetch, port: cfg.RUNNER_PORT, hostname: cfg.RUNNER_HOST });

  const shutdown = async (signal: string) => {
    console.log(`[runner ${cfg.RUNNER_ID}] ${signal}: draining`);
    ready = false;
    await host.drain(30_000);
    server.close();
    await Promise.all([store.close(), lease.close(), bus.close()]);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  console.log(`[runner ${cfg.RUNNER_ID}] listening on http://${cfg.RUNNER_HOST}:${cfg.RUNNER_PORT} store=${cfg.STORE} redis=${cfg.REDIS_URL ? "yes" : "memory"} platform=${platform.map((p) => p.config.id).join(",") || "none"}`);
  return { app, server, host, store, lease, bus, cfg, close: () => shutdown("close") };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  startRunner().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
