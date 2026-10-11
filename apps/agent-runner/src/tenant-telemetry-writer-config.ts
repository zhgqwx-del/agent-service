import {
  TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256,
  TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL,
  TenantTelemetryWriterWorker,
} from "@agent-service/core";
import {
  FILESYSTEM_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  FilesystemTenantTelemetryWriteAdapter,
  tenantTelemetryLifecycleTargetRootSha256,
  tenantTelemetryRefKeyIdSha256,
  type TenantTelemetryApplicationCaptureStore,
  type TenantTelemetryApplicationDomainControl,
  type TenantTelemetryLifecycleControlRecord,
  type TenantTelemetryLifecycleStore,
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
  adapter?: FilesystemTenantTelemetryWriteAdapter;
  worker?: TenantTelemetryWriterWorker;
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
    || config.TENANT_TELEMETRY_WRITER_ADAPTER !== "filesystem"
    || config.TENANT_TELEMETRY_FILESYSTEM_SINGLE_RUNNER !== true
    || !config.TENANT_TELEMETRY_REF_KEY
    || !config.TENANT_TELEMETRY_FILESYSTEM_NAMESPACE_ID
    || !config.TENANT_TELEMETRY_FILESYSTEM_FAILURE_DOMAIN_ID) {
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
  if (targets.length !== 2
    || tenantTelemetryLifecycleTargetRootSha256(targets) !== control.targetRootSha256
    || targets.some((target) => (
      target.adapterProtocol !== FILESYSTEM_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL
    ))) {
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
  let adapter: FilesystemTenantTelemetryWriteAdapter;
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
