import {
  TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256,
  TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL,
  TenantTelemetryWriterWorker,
} from "@agent-service/core";
import {
  FILESYSTEM_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  FilesystemTenantTelemetryWriteAdapter,
  S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  S3TenantTelemetryWriteAdapter,
  s3TenantTelemetryTargetIdentity,
  tenantTelemetryLifecycleTargetRootSha256,
  tenantTelemetryRefKeyIdSha256,
  type TenantTelemetryApplicationCaptureStore,
  type TenantTelemetryApplicationDomainControl,
  type TenantTelemetryLifecycleControlRecord,
  type TenantTelemetryLifecycleStore,
  type TenantTelemetryWriteAdapter,
  type TenantTelemetryWriterStore,
} from "@agent-service/store";
import type { RunnerConfig } from "./config.js";

export interface TenantTelemetryWriterRuntime {
  control: TenantTelemetryLifecycleControlRecord;
  applicationControls: TenantTelemetryApplicationDomainControl[];
  /** The 0034 spool/sink worker is assembled and can drain both pre/post-cutover jobs. */
  active: boolean;
  /** Only this 0035 state grants the provider owner-scoped capture boundary write authority. */
  captureActive: boolean;
  adapter?: TenantTelemetryWriteAdapter;
  worker?: TenantTelemetryWriterWorker;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function localInsecureS3Endpoint(config: RunnerConfig): boolean {
  if (config.NODE_ENV === "production" || !config.TENANT_TELEMETRY_S3_ENDPOINT) return false;
  const endpoint = new URL(config.TENANT_TELEMETRY_S3_ENDPOINT);
  return endpoint.protocol === "http:" && LOOPBACK_HOSTS.has(endpoint.hostname);
}

/**
 * Reconcile the durable 0033 control before any application writer or HTTP listener can start.
 * Inactive databases remain completely dormant and do not create the configured sink directory.
 * Once active, the runner refuses to start unless its worker and exact physical target binding are
 * present; silently accumulating a spool behind an absent or wrong sink is not an allowed mode.
 */
export async function reconcileTenantTelemetryWriterForStartup(
  store: TenantTelemetryLifecycleStore
    & TenantTelemetryApplicationCaptureStore
    & TenantTelemetryWriterStore,
  config: RunnerConfig,
  logger: Pick<Console, "warn">,
): Promise<TenantTelemetryWriterRuntime> {
  const control = await store.getTenantTelemetryLifecycleControl();
  const applicationControls = await store.listTenantTelemetryApplicationDomainControls();
  if (applicationControls.length !== 2
    || applicationControls[0]?.domain !== "logs"
    || applicationControls[1]?.domain !== "traces") {
    throw new Error("tenant telemetry application capture controls are incomplete");
  }
  if (control.state === "inactive") {
    if (applicationControls.some((candidate) => candidate.state !== "inactive")) {
      throw new Error("application capture cannot be active before the telemetry lifecycle");
    }
    if (config.TENANT_TELEMETRY_WRITER_ENABLED) {
      throw new Error(
        "tenant telemetry lifecycle must be activated before enabling the writer",
      );
    }
    return { control, applicationControls, active: false, captureActive: false };
  }
  if (!config.TENANT_TELEMETRY_WRITER_ENABLED
    || config.TENANT_TELEMETRY_WRITER_ADAPTER === undefined
    || !config.TENANT_TELEMETRY_REF_KEY) {
    throw new Error(
      "the tenant telemetry writer and exact adapter are required after lifecycle activation",
    );
  }
  if (tenantTelemetryRefKeyIdSha256(
    Buffer.from(config.TENANT_TELEMETRY_REF_KEY, "hex"),
  ) !== control.refKeyIdSha256) {
    throw new Error("the active tenant telemetry ref key does not match the durable control");
  }
  const targets = await store.listTenantTelemetryLifecycleTargets();
  const adapterProtocol = config.TENANT_TELEMETRY_WRITER_ADAPTER === "filesystem"
    ? FILESYSTEM_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL
    : S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL;
  if (targets.length !== 2
    || tenantTelemetryLifecycleTargetRootSha256(targets) !== control.targetRootSha256
    || targets.some((target) => target.adapterProtocol !== adapterProtocol)) {
    throw new Error("the active tenant telemetry targets do not match the configured adapter");
  }
  const logsControl = applicationControls[0]!;
  const tracesControl = applicationControls[1]!;
  if (tracesControl.state === "active") {
    throw new Error("the current runner has no activated traces producer contract");
  }
  if (logsControl.state === "active") {
    const logsTarget = targets.find((target) => target.domain === "logs");
    if (!logsTarget
      || logsControl.lifecycleControlEvidenceSha256 !== control.activationEvidenceSha256
      || logsControl.lifecycleTargetSha256 !== logsTarget.targetSha256
      || logsControl.lifecycleTargetReceiptSha256 !== logsTarget.receiptSha256
      || logsControl.refKeyIdSha256 !== control.refKeyIdSha256
      || logsControl.producerProtocol
        !== TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL
      || logsControl.producerContractSha256
        !== TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256) {
      throw new Error("the active logs capture is not bound to this producer contract");
    }
  }
  let adapter: TenantTelemetryWriteAdapter;
  if (config.TENANT_TELEMETRY_WRITER_ADAPTER === "filesystem") {
    if (config.TENANT_TELEMETRY_FILESYSTEM_SINGLE_RUNNER !== true
      || !config.TENANT_TELEMETRY_FILESYSTEM_NAMESPACE_ID
      || !config.TENANT_TELEMETRY_FILESYSTEM_FAILURE_DOMAIN_ID) {
      throw new Error("the active tenant telemetry filesystem target binding is invalid");
    }
    try {
      adapter = new FilesystemTenantTelemetryWriteAdapter({
        root: config.TENANT_TELEMETRY_FILESYSTEM_DIR,
        namespaceId: config.TENANT_TELEMETRY_FILESYSTEM_NAMESPACE_ID,
        failureDomainId: config.TENANT_TELEMETRY_FILESYSTEM_FAILURE_DOMAIN_ID,
        expectedTargets: targets,
        localOnly: true,
        singleRunner: config.TENANT_TELEMETRY_FILESYSTEM_SINGLE_RUNNER,
      });
    } catch {
      throw new Error("the active tenant telemetry filesystem target binding is invalid");
    }
  } else {
    const namespaceId = config.TENANT_TELEMETRY_S3_NAMESPACE_ID;
    const failureDomainId = config.TENANT_TELEMETRY_S3_FAILURE_DOMAIN_ID;
    const bucket = config.TENANT_TELEMETRY_S3_BUCKET;
    if (!namespaceId || !failureDomainId || !bucket
      || config.TENANT_TELEMETRY_S3_PRIVATE_BUCKET_ACK !== true) {
      throw new Error("the active tenant telemetry S3 target binding is invalid");
    }
    try {
      for (const target of targets) {
        const identity = s3TenantTelemetryTargetIdentity({
          namespaceId,
          failureDomainId,
          bucket,
          prefix: config.TENANT_TELEMETRY_S3_PREFIX,
          region: config.TENANT_TELEMETRY_S3_REGION,
          endpoint: config.TENANT_TELEMETRY_S3_ENDPOINT ?? null,
          forcePathStyle: config.TENANT_TELEMETRY_S3_FORCE_PATH_STYLE,
          domain: target.domain,
          ...(localInsecureS3Endpoint(config)
            ? { allowInsecureHttpForLocalTest: true as const }
            : {}),
        });
        if (target.backendKind !== identity.backendKind
          || target.adapterProtocol !== identity.adapterProtocol
          || target.namespaceSha256 !== identity.namespaceSha256
          || target.failureDomainSha256 !== identity.failureDomainSha256) {
          throw new Error("target mismatch");
        }
      }
      const candidate = new S3TenantTelemetryWriteAdapter({
        privateBucketAcknowledged: true,
        bucket,
        prefix: config.TENANT_TELEMETRY_S3_PREFIX,
        namespaceId,
        failureDomainId,
        region: config.TENANT_TELEMETRY_S3_REGION,
        endpoint: config.TENANT_TELEMETRY_S3_ENDPOINT ?? null,
        forcePathStyle: config.TENANT_TELEMETRY_S3_FORCE_PATH_STYLE,
        expectedTargets: targets,
        requestTimeoutMs: config.TENANT_TELEMETRY_S3_REQUEST_TIMEOUT_MS,
        ...(config.TENANT_TELEMETRY_S3_ACCESS_KEY_ID === undefined
          ? {}
          : {
              credentials: {
                accessKeyId: config.TENANT_TELEMETRY_S3_ACCESS_KEY_ID,
                secretAccessKey: config.TENANT_TELEMETRY_S3_SECRET_ACCESS_KEY!,
                ...(config.TENANT_TELEMETRY_S3_SESSION_TOKEN === undefined
                  ? {}
                  : { sessionToken: config.TENANT_TELEMETRY_S3_SESSION_TOKEN }),
              },
            }),
        ...(localInsecureS3Endpoint(config)
          ? { allowInsecureHttpForLocalTest: true as const }
          : {}),
      });
      try {
        await candidate.validateStartup();
      } catch {
        await Promise.resolve(candidate.destroy()).catch(() => {});
        throw new Error("startup validation failed");
      }
      adapter = candidate;
    } catch {
      throw new Error("the active tenant telemetry S3 target binding or startup is invalid");
    }
  }
  try {
    const worker = new TenantTelemetryWriterWorker({ store, adapter, logger }, {
      pollIntervalMs: config.TENANT_TELEMETRY_WRITER_POLL_MS,
      leaseMs: config.TENANT_TELEMETRY_WRITER_LEASE_MS,
      batchSize: config.TENANT_TELEMETRY_WRITER_BATCH_SIZE,
      retryBaseMs: config.TENANT_TELEMETRY_WRITER_RETRY_BASE_MS,
      retryMaxMs: config.TENANT_TELEMETRY_WRITER_RETRY_MAX_MS,
    });
    return {
      control,
      applicationControls,
      active: true,
      captureActive: logsControl.state === "active",
      adapter,
      worker,
    };
  } catch (error) {
    await adapter.close().catch(() => {});
    throw error;
  }
}
