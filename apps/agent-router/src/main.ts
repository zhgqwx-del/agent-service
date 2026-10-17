import { serve } from "@hono/node-server";
import {
  createEphemeralStructuredTelemetry,
  createRuntimeMetrics,
  tenantRedisNamespaceSha256,
  type StructuredTelemetryFields,
} from "@agent-service/protocol";
import { createRouterApp } from "./app.js";
import { loadRouterConfig } from "./config.js";
import { isDirectCliEntrypoint } from "./cli-entrypoint.js";
import { RunnerRegistry } from "./registry.js";

const ROUTER_TELEMETRY_LEVEL = {
  "router.lifecycle.draining": "info",
  "router.lifecycle.started": "info",
  "router.process.start_failed": "error",
} as const;

export type RouterTelemetryEventCode = keyof typeof ROUTER_TELEMETRY_LEVEL;
type RouterMainTelemetryFields = Pick<
  StructuredTelemetryFields,
  "runnerCount" | "shutdownGraceMs" | "gateEnabledCount" | "gateDisabledCount"
>;
const ROUTER_TELEMETRY_OUTPUT: Pick<Console, "info" | "warn" | "error"> = {
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};
const routerProcessTelemetry = createEphemeralStructuredTelemetry(
  "router",
  ROUTER_TELEMETRY_OUTPUT,
);

/**
 * Bootstrap-safe telemetry boundary. Only fixed event codes and boolean/numeric fields are
 * accepted, so runner URLs, tenant data, provider configuration and dependency errors cannot be
 * serialized into stdout/stderr. A later durable adapter can consume this envelope unchanged.
 */
export function emitRouterTelemetryEvent(
  event: RouterTelemetryEventCode,
  fields: RouterMainTelemetryFields = {},
): void {
  const level = ROUTER_TELEMETRY_LEVEL[event];
  routerProcessTelemetry[level](event, fields);
}

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
    ...(cfg.skillRegistryStorage === undefined ? {} : { skillRegistryStorage: cfg.skillRegistryStorage }),
    ...(cfg.RESTORE_JOURNAL_NAMESPACE_SHA256 === undefined
      ? {}
      : {
          restoreJournalNamespaceSha256: cfg.RESTORE_JOURNAL_NAMESPACE_SHA256,
          restoreJournalTargetRootSha256: cfg.RESTORE_JOURNAL_TARGET_ROOT_SHA256!,
          restoreRuntimeEpochSha256: cfg.RESTORE_JOURNAL_RUNTIME_EPOCH_SHA256!,
        }),
    healthIntervalMs: cfg.HEALTH_INTERVAL_MS,
  });
  registry.start();
  await registry.waitForFirstProbe(5_000);
  let ready = true;
  const app = createRouterApp({
    registry,
    telemetry: routerProcessTelemetry,
    ...(cfg.METRICS_BEARER_TOKEN === undefined ? {} : {
      metrics: { bearerToken: cfg.METRICS_BEARER_TOKEN,
        ...(cfg.METRICS_ENABLED ? { registry: createRuntimeMetrics("router") } : {}),
      },
    }),
    maxAttempts: cfg.MAX_ATTEMPTS,
    maxBodyBytes: cfg.MAX_BODY_BYTES,
    maxBlobBytes: cfg.BLOB_MAX_BYTES,
    upstreamHeaderTimeoutMs: cfg.UPSTREAM_HEADER_TIMEOUT_MS,
    adminToken: cfg.ROUTER_ADMIN_TOKEN,
    ready: () => ready,
    internalRunnerToken: cfg.INTERNAL_ROUTER_TOKEN,
    skillRegistryEnabled: () => cfg.SKILL_REGISTRY_ENABLED,
    skillRegistryOperatorToken: cfg.SKILL_REGISTRY_OPERATOR_TOKEN,
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
    tenantRestoreJournalExecutionEnabled: () => (
      cfg.TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED
    ),
    tenantPurgeExecutionEnabled: () => cfg.TENANT_PURGE_EXECUTION_ENABLED,
    tenantDatabasePurgeEnabled: () => cfg.TENANT_DATABASE_PURGE_ENABLED,
    ordinarySessionUsageRetentionEnabled: () => cfg.SESSION_USAGE_RETENTION_ENABLED,
    persistedProviderFailureCaptureFleetEnabled: () => cfg.PERSISTED_PROVIDER_FAILURE_CAPTURE_FLEET_ENABLED,
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
    emitRouterTelemetryEvent(
      "router.lifecycle.draining",
      cfg.SHUTDOWN_GRACE_MS > 0 ? { shutdownGraceMs: cfg.SHUTDOWN_GRACE_MS } : {},
    );
    await new Promise((r) => setTimeout(r, cfg.SHUTDOWN_GRACE_MS));
    server.close();
    await registry.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  const gateStates = [
    cfg.SESSION_TOMBSTONE_ENABLED,
    cfg.BLOB_ATTACHMENTS_ENABLED,
    cfg.DATA_ERASURE_REQUESTS_ENABLED,
    cfg.TENANT_ERASURE_REQUESTS_ENABLED,
    cfg.CREDENTIAL_LIFECYCLE_TRACKING_ENABLED,
    cfg.TENANT_CREDENTIAL_REVOCATION_EXECUTION_ENABLED,
    cfg.TENANT_CREDENTIAL_TARGET_EXECUTION_ENABLED,
    cfg.TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED,
    cfg.TENANT_PURGE_EXECUTION_ENABLED,
    cfg.TENANT_DATABASE_PURGE_ENABLED,
    cfg.SESSION_USAGE_RETENTION_ENABLED,
    cfg.PERSISTED_PROVIDER_FAILURE_CAPTURE_FLEET_ENABLED,
    cfg.TENANT_REDIS_PURGE_ENABLED,
    cfg.TENANT_RUNTIME_DRAIN_EXECUTION_ENABLED,
    cfg.DATA_GOVERNANCE_MANAGEMENT_ENABLED,
    cfg.PURGE_POLICY_EVALUATOR_ENABLED,
    cfg.DATA_EXPORT_REQUESTS_ENABLED,
  ];
  const gateEnabledCount = gateStates.filter(Boolean).length;
  emitRouterTelemetryEvent("router.lifecycle.started", {
    runnerCount: cfg.runnerList.length,
    gateEnabledCount,
    gateDisabledCount: gateStates.length - gateEnabledCount,
  });
  return { app, server, registry, cfg, close: shutdown };
}

if (isDirectCliEntrypoint(import.meta.url)) {
  startRouter().catch(() => {
    emitRouterTelemetryEvent("router.process.start_failed");
    process.exit(1);
  });
}
