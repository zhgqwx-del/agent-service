import { serve } from "@hono/node-server";
import { createRouterApp } from "./app.js";
import { loadRouterConfig } from "./config.js";
import { RunnerRegistry } from "./registry.js";

export async function startRouter(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadRouterConfig(env);
  const registry = new RunnerRegistry({
    runners: cfg.runnerList,
    redisUrl: cfg.REDIS_URL,
    healthIntervalMs: cfg.HEALTH_INTERVAL_MS,
  });
  registry.start();
  await registry.waitForFirstProbe(5_000);
  let ready = true;
  const app = createRouterApp({
    registry,
    maxAttempts: cfg.MAX_ATTEMPTS,
    maxBodyBytes: cfg.MAX_BODY_BYTES,
    maxBlobBytes: cfg.BLOB_MAX_BYTES,
    upstreamHeaderTimeoutMs: cfg.UPSTREAM_HEADER_TIMEOUT_MS,
    adminToken: cfg.ROUTER_ADMIN_TOKEN,
    ready: () => ready,
    internalRunnerToken: cfg.INTERNAL_ROUTER_TOKEN,
    tombstoneEnabled: () => cfg.SESSION_TOMBSTONE_ENABLED,
    blobAttachmentsEnabled: () => cfg.BLOB_ATTACHMENTS_ENABLED,
  });
  const server = serve({ fetch: app.fetch, port: cfg.ROUTER_PORT, hostname: cfg.ROUTER_HOST });
  /**
   * Drain: stop reporting ready so the load balancer takes us out, give in-flight SSE streams a grace
   * period, then close. Cutting the listener immediately would drop every streaming turn.
   */
  const shutdown = async () => {
    ready = false;
    console.log(`[router] draining for ${cfg.SHUTDOWN_GRACE_MS}ms`);
    await new Promise((r) => setTimeout(r, cfg.SHUTDOWN_GRACE_MS));
    server.close();
    await registry.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  console.log(`[router] listening on http://${cfg.ROUTER_HOST}:${cfg.ROUTER_PORT} → ${cfg.runnerList.join(", ")} directory=${cfg.REDIS_URL ? "redis" : "hash-only"} tombstone=${cfg.SESSION_TOMBSTONE_ENABLED ? "enabled" : "gated"} blobs=${cfg.BLOB_ATTACHMENTS_ENABLED ? "enabled" : "gated"}`);
  return { app, server, registry, cfg, close: shutdown };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  startRouter().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
