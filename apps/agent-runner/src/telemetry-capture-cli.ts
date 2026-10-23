import {
  MysqlSessionStore,
  TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID,
  S3TenantTelemetryWriteAdapter,
  s3TenantTelemetryTargetIdentity,
  tenantTelemetryLifecycleTargetSha256,
  tenantTelemetryLifecycleTargetReceiptSha256,
  tenantTelemetryRefKeyIdSha256,
  type ActivateTenantTelemetryLifecycleInput,
  type S3TenantTelemetryWriteAdapterOptions,
  type TenantTelemetryApplicationCaptureStore,
  type TenantTelemetryLifecycleStore,
  type TenantTelemetryLifecycleTargetRecord,
  type TenantTelemetryPersistedProviderCaptureStore,
  type PersistedProviderStepFailureSourceVerification,
  type VerifyPersistedProviderStepFailureSourceInput,
  type SchemaMetadataReaderConfig,
} from "@agent-service/store";
import { z } from "zod";
import { loadMysqlSchemaRuntimeConfig } from "./mysql-schema-config.js";
import { readTelemetryCaptureRefKey } from "./telemetry-capture-ref-key.js";

const COMMANDS = ["status", "preflight", "activate-lifecycle", "activate-logs", "verify-source"] as const;
const SHA256 = /^[0-9a-f]{64}$/;
type Command = typeof COMMANDS[number];
type CliStore = TenantTelemetryLifecycleStore & TenantTelemetryApplicationCaptureStore
  & TenantTelemetryPersistedProviderCaptureStore & { close(): Promise<void> };
interface ProbeAdapter { validateStartup(): Promise<void>; destroy(): void }

export interface TelemetryCaptureCliDependencies {
  readRefKey(path: string): Promise<Buffer>;
  connectStore(options: { url: string; connectionLimit: number; migrationMode: "verify";
    schemaMetadata: SchemaMetadataReaderConfig;
    tenantTelemetryRefKey?: Uint8Array; operationAbortSignal: AbortSignal;
    tenantTelemetryPersistedProviderCaptureLocalOnly?: boolean }): Promise<CliStore>;
  createAdapter(options: S3TenantTelemetryWriteAdapterOptions): ProbeAdapter;
  writeLine(line: string): void;
}
const DEFAULT_DEPENDENCIES: TelemetryCaptureCliDependencies = {
  readRefKey: readTelemetryCaptureRefKey,
  connectStore: (options) => MysqlSessionStore.connect(options),
  createAdapter: (options) => new S3TenantTelemetryWriteAdapter(options),
  writeLine: (line) => process.stdout.write(`${line}\n`),
};

const BaseEnv = z.object({
  NODE_ENV: z.enum(["development", "test"]).optional(),
  STORE: z.literal("mysql").optional(),
  MYSQL_URL: z.string().min(1).max(4_096).refine((value) => {
    try { return value.trim() === value && new URL(value).protocol === "mysql:"; } catch { return false; }
  }),
  TELEMETRY_CAPTURE_REF_KEY_FILE: z.string().min(1).max(4_096).optional(),
  TELEMETRY_CAPTURE_OPERATION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(30_000),
});
const ActivationAcks = z.object({
  TELEMETRY_CAPTURE_LOCAL_ONLY_ACK: z.literal("1"),
  TELEMETRY_CAPTURE_FLEET_STOPPED_ACK: z.literal("1"),
  TELEMETRY_CAPTURE_LEGACY_WRITERS_DRAINED_ACK: z.literal("1"),
  TELEMETRY_CAPTURE_PRODUCER_READY_ACK: z.literal("1"),
  TELEMETRY_CAPTURE_CONFIGURED_FLEET_ROOT_SHA256: z.string().regex(SHA256),
});
const SourceEnv = z.object({
  TELEMETRY_CAPTURE_TENANT_ID: z.string().min(1).max(128),
  TELEMETRY_CAPTURE_SESSION_ID: z.string().min(1).max(128),
  TELEMETRY_CAPTURE_TURN_ID: z.string().min(1).max(128),
  TELEMETRY_CAPTURE_ITEM_ID: z.string().min(1).max(128),
  TELEMETRY_CAPTURE_STEP_INDEX: z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number)
    .refine(Number.isSafeInteger),
});
const S3Env = z.object({
  TENANT_TELEMETRY_WRITER_ADAPTER: z.literal("s3"),
  TENANT_TELEMETRY_S3_NAMESPACE_ID: z.string().min(1).max(128),
  TENANT_TELEMETRY_S3_FAILURE_DOMAIN_ID: z.string().min(1).max(128),
  TENANT_TELEMETRY_S3_BUCKET: z.string().min(3).max(63),
  TENANT_TELEMETRY_S3_PREFIX: z.string().min(1).max(512).default("tenant-telemetry"),
  TENANT_TELEMETRY_S3_REGION: z.string().min(1).max(64).default("us-east-1"),
  TENANT_TELEMETRY_S3_ENDPOINT: z.string().min(1).max(2_048),
  TENANT_TELEMETRY_S3_FORCE_PATH_STYLE: z.enum(["0", "1"]).default("1"),
  TENANT_TELEMETRY_S3_PRIVATE_BUCKET_ACK: z.literal("1"),
  TENANT_TELEMETRY_S3_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  TENANT_TELEMETRY_S3_ACCESS_KEY_ID: z.string().min(1).max(128),
  TENANT_TELEMETRY_S3_SECRET_ACCESS_KEY: z.string().min(1).max(512),
  TENANT_TELEMETRY_S3_SESSION_TOKEN: z.string().min(1).max(4_096).optional(),
});
function failure(): never { throw new Error("operation_failed"); }

function s3Options(env: NodeJS.ProcessEnv) {
  const parsed = S3Env.parse(env);
  const endpoint = new URL(parsed.TENANT_TELEMETRY_S3_ENDPOINT);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || endpoint.pathname !== "/"
    || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname)) failure();
  return {
    privateBucketAcknowledged: true as const,
    bucket: parsed.TENANT_TELEMETRY_S3_BUCKET,
    prefix: parsed.TENANT_TELEMETRY_S3_PREFIX,
    region: parsed.TENANT_TELEMETRY_S3_REGION,
    endpoint: endpoint.origin,
    forcePathStyle: parsed.TENANT_TELEMETRY_S3_FORCE_PATH_STYLE === "1",
    namespaceId: parsed.TENANT_TELEMETRY_S3_NAMESPACE_ID,
    failureDomainId: parsed.TENANT_TELEMETRY_S3_FAILURE_DOMAIN_ID,
    requestTimeoutMs: parsed.TENANT_TELEMETRY_S3_REQUEST_TIMEOUT_MS,
    credentials: { accessKeyId: parsed.TENANT_TELEMETRY_S3_ACCESS_KEY_ID,
      secretAccessKey: parsed.TENANT_TELEMETRY_S3_SECRET_ACCESS_KEY,
      ...(parsed.TENANT_TELEMETRY_S3_SESSION_TOKEN === undefined ? {} : { sessionToken: parsed.TENANT_TELEMETRY_S3_SESSION_TOKEN }) },
    ...(endpoint.protocol === "http:" ? { allowInsecureHttpForLocalTest: true as const } : {}),
  };
}
type SinkOptions = ReturnType<typeof s3Options>;
function activationInput(options: SinkOptions): ActivateTenantTelemetryLifecycleInput {
  return { expectedControlGeneration: 0, targets: (["logs", "traces"] as const).map((domain) => ({
    domain, ...s3TenantTelemetryTargetIdentity({ ...options, domain }),
  })) };
}
/** Prospective target hashes are for startup probes only: never persisted or used for writes. */
function prospectiveProbeTargets(input: ActivateTenantTelemetryLifecycleInput): TenantTelemetryLifecycleTargetRecord[] {
  return input.targets.map((target, ordinal) => {
    const body = { ...target, singletonId: TENANT_TELEMETRY_LIFECYCLE_CONTROL_SINGLETON_ID,
      controlGeneration: 1 as const, targetOrdinal: ordinal as 0 | 1,
      scope: "tenant-telemetry-lifecycle-target-v1" as const, createdAtDbMs: 0 };
    const identified = { ...body, targetSha256: tenantTelemetryLifecycleTargetSha256(body) };
    return { ...identified, receiptSha256: tenantTelemetryLifecycleTargetReceiptSha256(identified) };
  });
}
function assertTargets(targets: readonly TenantTelemetryLifecycleTargetRecord[], options: SinkOptions) {
  if (targets.length !== 2 || targets[0]?.domain !== "logs" || targets[1]?.domain !== "traces") failure();
  for (const target of targets) {
    const identity = s3TenantTelemetryTargetIdentity({ ...options, domain: target.domain });
    for (const field of ["backendKind", "adapterProtocol", "namespaceSha256", "failureDomainSha256"] as const) {
      if (target[field] !== identity[field]) failure();
    }
  }
}
function verifiedSourceSummary(result: PersistedProviderStepFailureSourceVerification) {
  const status = z.enum(["not_found", "source_verified_queued", "source_verified_reserved",
    "source_verified_written", "source_verified_blocked"]).parse(result.status);
  if (result.executionReady !== false || result.allDomainsComplete !== false
    || result.sourceCount !== (status === "not_found" ? 0 : 1)) failure();
  const digest = z.string().regex(SHA256).nullable();
  return { sourceStatus: status, sourceCount: result.sourceCount,
    failureCommitReceiptSha256: digest.parse(result.failureCommitReceiptSha256),
    sourceBindingReceiptSha256: digest.parse(result.sourceBindingReceiptSha256),
    writeOperationSha256: digest.parse(result.writeOperationSha256),
    membershipSha256: digest.parse(result.membershipSha256),
    writeAckReceiptSha256: digest.parse(result.writeAckReceiptSha256),
    inventoryReceiptSha256: digest.parse(result.inventoryReceiptSha256) };
}

export async function runTelemetryCaptureCli(argv: readonly string[], env: NodeJS.ProcessEnv,
  dependencies: TelemetryCaptureCliDependencies = DEFAULT_DEPENDENCIES): Promise<void> {
  let store: CliStore | undefined;
  let key: Buffer | undefined;
  const adapters: ProbeAdapter[] = [];
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (argv.length !== 1 || !(COMMANDS as readonly string[]).includes(argv[0]!)) failure();
    const command = argv[0] as Command;
    const base = BaseEnv.parse(env); // Reject production before reading a key or opening resources.
    if (Reflect.ownKeys(env).some(key => typeof key === "string" && key.startsWith("AUTHORITY_"))) failure();
    const schemaMetadata = loadMysqlSchemaRuntimeConfig(env, "mysql");
    if (!schemaMetadata) failure();
    if (env.TENANT_TELEMETRY_REF_KEY !== undefined) failure();
    const activation = command === "activate-lifecycle" || command === "activate-logs"
      ? ActivationAcks.parse(env) : undefined;
    const source = command === "verify-source" ? SourceEnv.parse(env) : undefined;
    const sink = command === "preflight" || activation !== undefined ? s3Options(env) : undefined;
    if (command !== "status" && base.TELEMETRY_CAPTURE_REF_KEY_FILE === undefined) failure();

    controller = new AbortController();
    const signal = controller.signal;
    const started = Date.now();
    timer = setTimeout(() => controller!.abort(), base.TELEMETRY_CAPTURE_OPERATION_TIMEOUT_MS);
    timer.unref();
    const remaining = () => {
      if (signal.aborted) failure();
      const time = base.TELEMETRY_CAPTURE_OPERATION_TIMEOUT_MS - (Date.now() - started);
      if (time <= 0) { controller!.abort(); failure(); }
      return time;
    };
    if (base.TELEMETRY_CAPTURE_REF_KEY_FILE !== undefined) {
      key = await dependencies.readRefKey(base.TELEMETRY_CAPTURE_REF_KEY_FILE);
      if (key.length !== 32) failure();
    }
    remaining();
    store = await dependencies.connectStore({ url: base.MYSQL_URL, connectionLimit: 3,
      migrationMode: "verify", schemaMetadata, operationAbortSignal: signal,
      ...(command === "status" ? {} : { tenantTelemetryPersistedProviderCaptureLocalOnly: true }),
      ...(key === undefined ? {} : { tenantTelemetryRefKey: key }) });
    remaining();
    const connected = store;
    let summary: Record<string, unknown>;
    const readStatus = async () => {
      const lifecycle = await connected.getTenantTelemetryLifecycleControl();
      const capture = await connected.getTenantTelemetryPersistedProviderCaptureControl();
      remaining();
      const lifecycleState = z.enum(["inactive", "active"]).parse(lifecycle.state);
      const captureState = z.enum(["inactive", "active"]).parse(capture.state);
      if (lifecycle.controlGeneration !== (lifecycleState === "inactive" ? 0 : 1)
        || capture.controlGeneration !== (captureState === "inactive" ? 0 : 1)) failure();
      return { lifecycleState, lifecycleControlGeneration: lifecycle.controlGeneration,
        captureState, captureControlGeneration: capture.controlGeneration };
    };
    if (command === "status") {
      // No named lock, adapter constructor, external read/probe or activation on this path.
      summary = await readStatus();
    } else {
      summary = await connected.withTenantTelemetryCaptureOperatorFence(async (fence) => {
        const boundary = async () => { remaining(); await fence.checkOwned(); remaining(); };
        await boundary();
        const prerequisites = await connected.getTenantTelemetryPersistedProviderCapturePrerequisites();
        await boundary();
        const applications = await connected.listTenantTelemetryApplicationDomainControls();
        if (applications.length !== 2 || applications.some((control) => control.state !== "inactive")) failure();
        await boundary();
        if (source) {
          const binding = await connected.getTenantTelemetryPersistedProviderCaptureBinding();
          if (!binding) failure();
          const input: VerifyPersistedProviderStepFailureSourceInput = {
            tenantId: source.TELEMETRY_CAPTURE_TENANT_ID, sessionId: source.TELEMETRY_CAPTURE_SESSION_ID,
            turnId: source.TELEMETRY_CAPTURE_TURN_ID, itemId: source.TELEMETRY_CAPTURE_ITEM_ID,
            stepIndex: source.TELEMETRY_CAPTURE_STEP_INDEX, freshProof: binding,
          };
          const verified = await connected.verifyPersistedProviderStepFailureSource(input);
          await boundary();
          return verifiedSourceSummary(verified);
        }
        const input = activationInput(sink!);
        let control = await connected.getTenantTelemetryLifecycleControl();
        let targets = await connected.listTenantTelemetryLifecycleTargets();
        if (control.state === "active") {
          if (control.refKeyIdSha256 !== tenantTelemetryRefKeyIdSha256(key!)) failure();
          assertTargets(targets, sink!);
        } else if (targets.length !== 0) failure();
        await boundary();
        const probe = dependencies.createAdapter({ ...sink!, operationAbortSignal: signal,
          requestTimeoutMs: Math.min(sink!.requestTimeoutMs, remaining()),
          expectedTargets: control.state === "active" ? targets : prospectiveProbeTargets(input) });
        adapters.push(probe);
        await probe.validateStartup();
        await boundary();
        if (command === "activate-lifecycle") {
          const activated = await connected.activateTenantTelemetryLifecycle(input);
          control = activated.control;
          targets = activated.targets;
          await boundary();
          // Always re-read durable identities after the commit; prospective targets are discarded.
          control = await connected.getTenantTelemetryLifecycleControl();
          targets = await connected.listTenantTelemetryLifecycleTargets();
          if (control.state !== "active" || control.refKeyIdSha256 !== tenantTelemetryRefKeyIdSha256(key!)) failure();
          assertTargets(targets, sink!);
          const real = dependencies.createAdapter({ ...sink!, operationAbortSignal: signal,
            requestTimeoutMs: Math.min(sink!.requestTimeoutMs, remaining()), expectedTargets: targets });
          adapters.push(real);
          await real.validateStartup();
          await boundary();
        } else if (command === "activate-logs") {
          if (control.state !== "active") failure();
          const logs = targets.find((target) => target.domain === "logs")!;
          await connected.activateTenantTelemetryPersistedProviderCapture({ expectedControlGeneration: 0,
            lifecycleControlEvidenceSha256: control.activationEvidenceSha256,
            logsTargetSha256: logs.targetSha256, logsTargetReceiptSha256: logs.receiptSha256,
            configuredFleetRootSha256: activation!.TELEMETRY_CAPTURE_CONFIGURED_FLEET_ROOT_SHA256,
            fleetStoppedAck: "fleet-stopped-v1", legacyWritersDrainedAck: "legacy-writers-drained-v1",
            producerReadyAck: "provider-step-error-v2-ready-v1", localOnlyAck: "local-only-v1" }, fence);
          await boundary();
          const binding = await connected.getTenantTelemetryPersistedProviderCaptureBinding();
          if (!binding || binding.configuredFleetRootSha256 !== activation!.TELEMETRY_CAPTURE_CONFIGURED_FLEET_ROOT_SHA256
            || binding.runtimeEpochSha256 !== prerequisites.runtimeEpochSha256
            || binding.runtimeBindingSha256 !== prerequisites.runtimeBindingSha256) failure();
        }
        await boundary();
        return { ...await readStatus(), capabilityProbe: true, mutatedProbeObjects: true,
          runtimeEpochSha256: prerequisites.runtimeEpochSha256, runtimeBindingSha256: prerequisites.runtimeBindingSha256,
          ...(activation === undefined ? {} : { fleetStoppedDeclaration: true, producerReadyDeclaration: true }) };
      }, { timeoutMs: remaining(), operationAbortSignal: signal });
    }
    remaining();
    for (const adapter of adapters.splice(0)) adapter.destroy();
    await connected.close();
    store = undefined;
    remaining();
    dependencies.writeLine(JSON.stringify({ status: "ok", command, ...summary,
      erasuresBlocked: true, executionReady: false, allDomainsComplete: false }));
  } catch {
    throw new Error("operation_failed");
  } finally {
    if (timer) clearTimeout(timer);
    controller?.abort();
    for (const adapter of adapters) { try { adapter.destroy(); } catch { /* no diagnostics */ } }
    if (store) await store.close().catch(() => {});
    key?.fill(0);
  }
}
