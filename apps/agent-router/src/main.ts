import { serve } from "@hono/node-server";
import {
  CloseFailures, ProcessHttpOwner,
  createEphemeralStructuredTelemetry,
  createRuntimeMetrics,
  tenantRedisNamespaceSha256,
  mcpRegistryCallbackUrlSha256, mcpCoordinationNamespaceSha256,
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
  "router.process.shutdown_failed": "error",
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
    ...(cfg.providerGatewayIdentity === undefined ? {} : { providerGatewayIdentity: cfg.providerGatewayIdentity }),
    redisUrl: cfg.REDIS_URL,
    redisPrefix: cfg.REDIS_PREFIX,
    redisNamespaceSha256,
    runtimeExtensions: { lifecycleHooks: cfg.LIFECYCLE_HOOKS_ENABLED, subagents: cfg.SUBAGENTS_ENABLED },
    ...(cfg.TENANT_HOOKS_ENABLED ? { tenantHooksMasterKeyId: cfg.HOOKS_MASTER_KEY_ID } : {}),
    ...(cfg.MCP_REGISTRY_ENABLED ? {
      mcpRegistryCredentialKeyId: cfg.MCP_REGISTRY_CREDENTIAL_KEY_ID,
      mcpRegistryCallbackUrlSha256: mcpRegistryCallbackUrlSha256(cfg.MCP_REGISTRY_OAUTH_CALLBACK_URL!),
      mcpRegistryCoordinationNamespaceSha256: mcpCoordinationNamespaceSha256({ prefix: cfg.REDIS_PREFIX, namespaceId: cfg.REDIS_NAMESPACE_ID! }),
    } : {}),
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
    providerGatewayEnabled: () => cfg.PROVIDER_GATEWAY_ENABLED,
    internalRunnerToken: cfg.INTERNAL_ROUTER_TOKEN,
    mcpRegistryEnabled: () => cfg.MCP_REGISTRY_ENABLED,
    tenantHooksEnabled: () => cfg.TENANT_HOOKS_ENABLED,
    lifecycleHooksEnabled: () => cfg.LIFECYCLE_HOOKS_ENABLED,
    subagentsEnabled: () => cfg.SUBAGENTS_ENABLED,
    mcpRegistryOperatorToken: cfg.MCP_REGISTRY_OPERATOR_TOKEN,
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
  const httpOwner = new ProcessHttpOwner(request => app.fetch(request));
  const server = serve({ fetch: httpOwner.fetch, port: cfg.ROUTER_PORT, hostname: cfg.ROUTER_HOST });
  let shutdownPromise: Promise<void> | undefined;
  let signalObserved = false;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    ready = false;
    httpOwner.stopAccepting();
    try { emitRouterTelemetryEvent("router.lifecycle.draining",
      cfg.SHUTDOWN_GRACE_MS > 0 ? { shutdownGraceMs: cfg.SHUTDOWN_GRACE_MS } : {}); }
    catch { /* Observation cannot prevent close. */ }
    shutdownPromise = (async () => {
      const failures = new CloseFailures();
      try {
        // Keep the configured grace unchanged; ready/new-handler admission is already fenced.
        await new Promise<void>(resolve => setTimeout(resolve, cfg.SHUTDOWN_GRACE_MS));
        const serverClosed = new Promise<void>((resolve, reject) => {
          try { server.close((error?: Error) => error ? reject(error) : resolve()); }
          catch (error) { reject(error); }
        });
        void serverClosed.catch(() => {});
        httpOwner.abort();
        const stoppedTransports = failures.start([() => registry.stop()]);
        // A partial incoming body need not observe Request.signal; actual socket close wakes that read.
        await failures.stage([() => { if ("closeIdleConnections" in server) server.closeIdleConnections(); }]);
        await failures.stage([() => { if ("closeAllConnections" in server) server.closeAllConnections(); }]);
        // A fetch Response can already exist while its actual upstream body is still active.
        await failures.stage([() => httpOwner.settle(), () => registry.close(), () => stoppedTransports]);
        await failures.stage([() => serverClosed]);
        failures.throwIfAny();
      } finally {
        process.off("SIGTERM", onSigterm); process.off("SIGINT", onSigint);
      }
    })();
    return shutdownPromise;
  };
  const signalShutdown = () => {
    if (signalObserved) return;
    signalObserved = true;
    void shutdown().then(() => { process.exitCode = 0; }, () => {
      process.exitCode = 1;
      try { emitRouterTelemetryEvent("router.process.shutdown_failed"); } catch { /* Preserve failed exit status. */ }
    });
  };
  const onSigterm = () => signalShutdown();
  const onSigint = () => signalShutdown();
  process.on("SIGTERM", onSigterm); process.on("SIGINT", onSigint);

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
    cfg.MCP_REGISTRY_ENABLED,
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
