import { serve } from "@hono/node-server";
import { tenantRedisNamespaceSha256 } from "@agent-service/protocol";
import { createRouterApp } from "./app.js";
import { loadRouterConfig } from "./config.js";
import { RunnerRegistry } from "./registry.js";

export async function startRouter(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadRouterConfig(env);
  const redisNamespaceSha256 = cfg.REDIS_NAMESPACE_ID
    ? tenantRedisNamespaceSha256(cfg.REDIS_NAMESPACE_ID, cfg.REDIS_PREFIX)
    : undefined;
  const registry = new RunnerRegistry({
    runners: cfg.runnerList,
    internalRouterToken: cfg.INTERNAL_ROUTER_TOKEN,
    redisUrl: cfg.REDIS_URL,
    redisPrefix: cfg.REDIS_PREFIX,
    redisNamespaceSha256,
    ...(cfg.blobStorage === undefined ? {} : { blobStorage: cfg.blobStorage }),
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
    erasureRequestsEnabled: () => cfg.DATA_ERASURE_REQUESTS_ENABLED,
    tenantErasureOperatorToken: cfg.TENANT_ERASURE_OPERATOR_TOKEN,
    tenantErasureOperatorId: cfg.TENANT_ERASURE_OPERATOR_ID,
    tenantErasureRequestsEnabled: () => cfg.TENANT_ERASURE_REQUESTS_ENABLED,
    dataGovernanceManagementEnabled: () => cfg.DATA_GOVERNANCE_MANAGEMENT_ENABLED,
    purgePolicyEvaluatorEnabled: () => cfg.PURGE_POLICY_EVALUATOR_ENABLED,
    tenantCredentialRevocationExecutionEnabled: () => (
      cfg.TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED
    ),
    credentialLifecycleTrackingEnabled: () => (
      cfg.CREDENTIAL_LIFECYCLE_TRACKING_ENABLED
    ),
    tenantCredentialTargetExecutionEnabled: () => (
      cfg.TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED
    ),
    tenantPurgeExecutionEnabled: () => cfg.TENANT_PURGE_EXECUTION_ENABLED,
    tenantDatabasePurgeEnabled: () => cfg.TENANT_DATABASE_PURGE_ENABLED,
    tenantRedisPurgeEnabled: () => cfg.TENANT_REDIS_PURGE_ENABLED,
    tenantRedisPurgeNamespaceSha256: redisNamespaceSha256,
    tenantRuntimeDrainExecutionEnabled: () => cfg.TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED,
    dataExportArtifactsEnabled: () => cfg.dataExportArtifactsReadable,
    dataExportRequestsEnabled: () => cfg.DATA_EXPORT_REQUESTS_ENABLED,
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
  console.log(`[router] listening on http://${cfg.ROUTER_HOST}:${cfg.ROUTER_PORT} → ${cfg.runnerList.join(", ")} directory=${cfg.REDIS_URL ? "redis" : "hash-only"} tombstone=${cfg.SESSION_TOMBSTONE_ENABLED ? "enabled" : "gated"} blobs=${cfg.BLOB_ATTACHMENTS_ENABLED ? "enabled" : "gated"} erasureRequests=${cfg.DATA_ERASURE_REQUESTS_ENABLED ? "enabled" : "gated"} tenantErasureRequests=${cfg.TENANT_ERASURE_REQUESTS_ENABLED ? "enabled" : "gated"} credentialLifecycleTracking=${cfg.CREDENTIAL_LIFECYCLE_TRACKING_ENABLED ? "enabled" : "gated"} tenantCredentialRevocation=${cfg.TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED ? "enabled" : "gated"} credentialTargetExecution=${cfg.TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED ? "enabled" : "gated"} tenantPurgeExecution=${cfg.TENANT_PURGE_EXECUTION_ENABLED ? "enabled" : "gated"} tenantDatabasePurge=${cfg.TENANT_DATABASE_PURGE_ENABLED ? "enabled" : "gated"} tenantRedisPurge=${cfg.TENANT_REDIS_PURGE_ENABLED ? "enabled" : "gated"} tenantRuntimeDrain=${cfg.TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED ? "enabled" : "gated"} dataGovernance=${cfg.DATA_GOVERNANCE_MANAGEMENT_ENABLED ? "enabled" : "gated"} purgePolicyEvaluator=${cfg.PURGE_POLICY_EVALUATOR_ENABLED ? "enabled" : "gated"} dataExportRequests=${cfg.DATA_EXPORT_REQUESTS_ENABLED ? "enabled" : "gated"}`);
  return { app, server, registry, cfg, close: shutdown };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  startRouter().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
