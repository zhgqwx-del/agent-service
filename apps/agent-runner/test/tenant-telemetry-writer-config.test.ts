import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256,
  TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL,
} from "@agent-service/core";
import {
  FILESYSTEM_TENANT_TELEMETRY_BACKEND_KIND,
  FILESYSTEM_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  MemorySessionStore,
  S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  S3TenantTelemetryWriteAdapter,
  TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
  TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
  TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  s3TenantTelemetryTargetIdentity,
  tenantTelemetryFilesystemFailureDomainSha256,
  tenantTelemetryFilesystemNamespaceSha256,
  type TenantTelemetryPersistedProviderCaptureProof,
} from "@agent-service/store";
import { loadConfig } from "../src/config.js";
import { reconcileTenantTelemetryWriterForStartup } from
  "../src/tenant-telemetry-writer-config.js";
import { activateMemoryPersistedProviderCapture } from "../../../packages/core/test/persisted-provider-capture-fixture.js";

const MASTER_KEY = "88".repeat(32);
const REF_KEY_HEX = "31".repeat(32);
const NAMESPACE_ID = "local-telemetry-runtime-v1";
const FAILURE_DOMAIN_ID = "local-workstation-v1";
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

async function rootPath(suffix = "sink"): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "agent-runner-telemetry-config-"));
  roots.push(parent);
  return join(parent, suffix);
}

function s3EnabledConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    NODE_ENV: "test",
    STORE: "mysql",
    SECRETS_MASTER_KEY: MASTER_KEY,
    TENANT_TELEMETRY_REF_KEY: REF_KEY_HEX,
    TENANT_TELEMETRY_WRITER_ENABLED: "1",
    TENANT_TELEMETRY_WRITER_ADAPTER: "s3",
    TENANT_TELEMETRY_S3_NAMESPACE_ID: "managed-telemetry-runtime-v1",
    TENANT_TELEMETRY_S3_FAILURE_DOMAIN_ID: "local-minio-fixture",
    TENANT_TELEMETRY_S3_ENDPOINT: "http://127.0.0.1:9000",
    TENANT_TELEMETRY_S3_REGION: "us-east-1",
    TENANT_TELEMETRY_S3_BUCKET: "agent-service-telemetry-test",
    TENANT_TELEMETRY_S3_PREFIX: "managed/v1",
    TENANT_TELEMETRY_S3_FORCE_PATH_STYLE: "1",
    TENANT_TELEMETRY_S3_PRIVATE_BUCKET_ACK: "1",
    TENANT_TELEMETRY_S3_ACCESS_KEY_ID: "fixture-access",
    TENANT_TELEMETRY_S3_SECRET_ACCESS_KEY: "fixture-secret",
    ...overrides,
  });
}

async function activeS3Store(
  config = s3EnabledConfig(),
): Promise<MemorySessionStore> {
  const store = new MemorySessionStore(
    { now: () => Date.now() },
    { tenantTelemetryRefKey: Buffer.from(REF_KEY_HEX, "hex") },
  );
  await store.activateTenantTelemetryLifecycle({
    expectedControlGeneration: 0,
    targets: (["logs", "traces"] as const).map((domain) => ({
      domain,
      ...s3TenantTelemetryTargetIdentity({
        namespaceId: config.TENANT_TELEMETRY_S3_NAMESPACE_ID!,
        failureDomainId: config.TENANT_TELEMETRY_S3_FAILURE_DOMAIN_ID!,
        bucket: config.TENANT_TELEMETRY_S3_BUCKET!,
        prefix: config.TENANT_TELEMETRY_S3_PREFIX,
        region: config.TENANT_TELEMETRY_S3_REGION,
        endpoint: config.TENANT_TELEMETRY_S3_ENDPOINT ?? null,
        forcePathStyle: config.TENANT_TELEMETRY_S3_FORCE_PATH_STYLE,
        domain,
        allowInsecureHttpForLocalTest: true,
      }),
    })),
  });
  return store;
}

function enabledConfig(root: string) {
  return loadConfig({
    NODE_ENV: "test",
    STORE: "mysql",
    SECRETS_MASTER_KEY: MASTER_KEY,
    TENANT_TELEMETRY_REF_KEY: REF_KEY_HEX,
    TENANT_TELEMETRY_WRITER_ENABLED: "1",
    TENANT_TELEMETRY_WRITER_ADAPTER: "filesystem",
    TENANT_TELEMETRY_FILESYSTEM_DIR: root,
    TENANT_TELEMETRY_FILESYSTEM_SINGLE_RUNNER: "1",
    TENANT_TELEMETRY_FILESYSTEM_NAMESPACE_ID: NAMESPACE_ID,
    TENANT_TELEMETRY_FILESYSTEM_FAILURE_DOMAIN_ID: FAILURE_DOMAIN_ID,
  });
}

async function activeStore(
  root: string,
  adapterProtocol: string = FILESYSTEM_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
): Promise<MemorySessionStore> {
  const store = new MemorySessionStore(
    { now: () => Date.now() },
    { tenantTelemetryRefKey: Buffer.from(REF_KEY_HEX, "hex") },
  );
  await store.activateTenantTelemetryLifecycle({
    expectedControlGeneration: 0,
    targets: (["logs", "traces"] as const).map((domain) => ({
      domain,
      backendKind: FILESYSTEM_TENANT_TELEMETRY_BACKEND_KIND,
      adapterProtocol,
      namespaceSha256: tenantTelemetryFilesystemNamespaceSha256(
        root,
        NAMESPACE_ID,
        domain,
      ),
      failureDomainSha256:
        tenantTelemetryFilesystemFailureDomainSha256(FAILURE_DOMAIN_ID),
    })),
  });
  return store;
}

async function activateCapture(
  store: MemorySessionStore,
  domain: "logs" | "traces" = "logs",
  producerProtocol: string = TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL,
  producerContractSha256: string = TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256,
): Promise<void> {
  const control = await store.getTenantTelemetryLifecycleControl();
  if (control.state !== "active") throw new Error("test lifecycle is inactive");
  const target = (await store.listTenantTelemetryLifecycleTargets())
    .find((candidate) => candidate.domain === domain)!;
  await store.activateTenantTelemetryApplicationCapture({
    domain,
    expectedControlGeneration: 0,
    expectedLifecycleControlGeneration: 1,
    lifecycleControlEvidenceSha256: control.activationEvidenceSha256,
    lifecycleTargetSha256: target.targetSha256,
    lifecycleTargetReceiptSha256: target.receiptSha256,
    producerProtocol,
    producerContractSha256,
    fleetStoppedAck: TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
    legacyWritersDrainedAck: TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
    producerReadyAck: TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  });
}

describe("tenant telemetry writer runner startup", () => {
  it("requires offline v2 activation and fresh-gate assembly, but local startup does not recursively call the router", async () => {
    const config = s3EnabledConfig({ RUNNER_ID: "unit-capture-startup", ERASURE_ROUTER_URL: "http://router:8080", PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED: "1",
      TENANT_TELEMETRY_S3_NAMESPACE_ID: "unit-capture", TENANT_TELEMETRY_S3_FAILURE_DOMAIN_ID: "unit-fake", TENANT_TELEMETRY_S3_BUCKET: "unit-capture",
      TENANT_TELEMETRY_S3_PREFIX: "capture", TENANT_TELEMETRY_S3_ENDPOINT: undefined, TENANT_TELEMETRY_S3_FORCE_PATH_STYLE: "0" });
    const store = new MemorySessionStore({ now: () => Date.now() }, { tenantTelemetryRefKey: Buffer.from(REF_KEY_HEX, "hex"), tenantTelemetryPersistedProviderCaptureLocalOnly: true });
    const validateStartup = vi.spyOn(S3TenantTelemetryWriteAdapter.prototype, "validateStartup").mockResolvedValue();
    const requireFreshFleet = vi.fn(async (expected: TenantTelemetryPersistedProviderCaptureProof) => expected);
    await expect(reconcileTenantTelemetryWriterForStartup(store, config, { warn() {} }, { requireFreshFleet })).rejects.toThrow(/activated offline/);
    expect(validateStartup).not.toHaveBeenCalled();
    await activateMemoryPersistedProviderCapture(store);
    await expect(reconcileTenantTelemetryWriterForStartup(store, { ...config, PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED: false }, { warn() {} }, { requireFreshFleet })).rejects.toThrow(/local keyed S3 writer/);
    await expect(reconcileTenantTelemetryWriterForStartup(store, config, { warn() {} })).rejects.toThrow(/fresh fleet gate/);
    const runtime = await reconcileTenantTelemetryWriterForStartup(store, config, { warn() {} }, { requireFreshFleet });
    expect(runtime).toMatchObject({ active: true, captureActive: false, persistedCaptureActive: true });
    expect(runtime.persistedCaptureBinding).toEqual(await store.getTenantTelemetryPersistedProviderCaptureBinding());
    expect(validateStartup).toHaveBeenCalledOnce();
    expect(requireFreshFleet).not.toHaveBeenCalled();
    await runtime.worker!.stop();
    await store.close();
  });

  it("leaves an inactive lifecycle dormant without creating the sink directory", async () => {
    const root = await rootPath();
    const store = new MemorySessionStore(
      { now: () => Date.now() },
      { tenantTelemetryRefKey: Buffer.from(REF_KEY_HEX, "hex") },
    );
    const runtime = await reconcileTenantTelemetryWriterForStartup(
      store,
      loadConfig({
        NODE_ENV: "test",
        STORE: "memory",
        SECRETS_MASTER_KEY: MASTER_KEY,
        TENANT_TELEMETRY_REF_KEY: REF_KEY_HEX,
      }),
      { warn: () => {} },
    );
    expect(runtime).toMatchObject({ active: false });
    expect(runtime.worker).toBeUndefined();
    expect(runtime.adapter).toBeUndefined();
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    await store.close();
  });

  it("refuses an enabled writer before the durable lifecycle is active", async () => {
    const root = await rootPath();
    const store = new MemorySessionStore(
      { now: () => Date.now() },
      { tenantTelemetryRefKey: Buffer.from(REF_KEY_HEX, "hex") },
    );
    await expect(reconcileTenantTelemetryWriterForStartup(
      store,
      enabledConfig(root),
      { warn: () => {} },
    )).rejects.toThrow(/must be activated before enabling/);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    await store.close();
  });

  it("assembles the embedded worker only for an exact active filesystem target set", async () => {
    const root = await rootPath();
    const store = await activeStore(root);
    const runtime = await reconcileTenantTelemetryWriterForStartup(
      store,
      enabledConfig(root),
      { warn: () => {} },
    );
    expect(runtime.active).toBe(true);
    expect(runtime.captureActive).toBe(false);
    expect(runtime.adapter?.adapterProtocol)
      .toBe(FILESYSTEM_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL);
    expect(runtime.worker).toBeDefined();
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    await runtime.worker!.stop();
    await store.close();
  });

  it("validates and assembles the embedded worker for an exact managed S3 target set", async () => {
    const config = s3EnabledConfig();
    const store = await activeS3Store(config);
    const validateStartup = vi.spyOn(
      S3TenantTelemetryWriteAdapter.prototype,
      "validateStartup",
    ).mockResolvedValue();
    const runtime = await reconcileTenantTelemetryWriterForStartup(
      store,
      config,
      { warn: () => {} },
    );
    expect(runtime.active).toBe(true);
    expect(runtime.captureActive).toBe(false);
    expect(runtime.adapter).toBeInstanceOf(S3TenantTelemetryWriteAdapter);
    expect(runtime.adapter?.adapterProtocol).toBe(S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL);
    expect(validateStartup).toHaveBeenCalledOnce();
    await runtime.worker!.stop();
    await store.close();
  });

  it("fails S3 startup on target drift or backend validation without leaking backend detail", async () => {
    const config = s3EnabledConfig();
    const drifted = await activeS3Store(config);
    const validateStartup = vi.spyOn(
      S3TenantTelemetryWriteAdapter.prototype,
      "validateStartup",
    ).mockResolvedValue();
    await expect(reconcileTenantTelemetryWriterForStartup(
      drifted,
      s3EnabledConfig({ TENANT_TELEMETRY_S3_PREFIX: "other/v1" }),
      { warn: () => {} },
    )).rejects.toThrow(/S3 target binding or startup is invalid/);
    expect(validateStartup).not.toHaveBeenCalled();
    await drifted.close();

    vi.restoreAllMocks();
    const unavailable = await activeS3Store(config);
    const privateDetail = "do-not-echo-s3-backend-detail";
    vi.spyOn(S3TenantTelemetryWriteAdapter.prototype, "validateStartup")
      .mockRejectedValue(new Error(privateDetail));
    const destroy = vi.spyOn(S3TenantTelemetryWriteAdapter.prototype, "destroy");
    let message = "";
    try {
      await reconcileTenantTelemetryWriterForStartup(
        unavailable,
        config,
        { warn: () => {} },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/S3 target binding or startup is invalid/);
    expect(message).not.toContain(privateDetail);
    expect(destroy).toHaveBeenCalledOnce();
    await unavailable.close();
  });

  it("grants owner capture only for the exact active 0035 logs producer contract", async () => {
    const root = await rootPath();
    const store = await activeStore(root);
    await activateCapture(store);
    const runtime = await reconcileTenantTelemetryWriterForStartup(
      store,
      enabledConfig(root),
      { warn: () => {} },
    );
    expect(runtime).toMatchObject({ active: true, captureActive: true });
    await runtime.worker!.stop();
    await store.close();

    const mismatched = await activeStore(root);
    await activateCapture(mismatched, "logs", "wrong-producer-v1", "9".repeat(64));
    await expect(reconcileTenantTelemetryWriterForStartup(
      mismatched,
      enabledConfig(root),
      { warn: () => {} },
    )).rejects.toThrow(/not bound to this producer contract/);
    await mismatched.close();
  });

  it("fails closed if traces are activated before a traces producer exists", async () => {
    const root = await rootPath();
    const store = await activeStore(root);
    await activateCapture(store, "traces", "future-traces-v1", "8".repeat(64));
    await expect(reconcileTenantTelemetryWriterForStartup(
      store,
      enabledConfig(root),
      { warn: () => {} },
    )).rejects.toThrow(/no activated traces producer contract/);
    await store.close();
  });

  it("fails startup once active when the worker or adapter is missing", async () => {
    const root = await rootPath();
    const store = await activeStore(root);
    const disabled = loadConfig({
      NODE_ENV: "test",
      STORE: "memory",
      SECRETS_MASTER_KEY: MASTER_KEY,
      TENANT_TELEMETRY_REF_KEY: REF_KEY_HEX,
    });
    await expect(reconcileTenantTelemetryWriterForStartup(
      store,
      disabled,
      { warn: () => {} },
    )).rejects.toThrow(/required after lifecycle activation/);
    await store.close();
  });

  it("fails startup for root, logical identity, or protocol drift", async () => {
    const root = await rootPath("canonical");
    const otherRoot = await rootPath("other");
    const store = await activeStore(root);
    await expect(reconcileTenantTelemetryWriterForStartup(
      store,
      enabledConfig(otherRoot),
      { warn: () => {} },
    )).rejects.toThrow(/target binding is invalid/);
    await store.close();

    const wrongProtocolStore = await activeStore(root, "telemetry-http-v1");
    await expect(reconcileTenantTelemetryWriterForStartup(
      wrongProtocolStore,
      enabledConfig(root),
      { warn: () => {} },
    )).rejects.toThrow(/do not match the configured adapter/);
    await wrongProtocolStore.close();
  });

  it("fails startup when the configured producer key does not match the active control", async () => {
    const root = await rootPath();
    const store = await activeStore(root);
    const config = enabledConfig(root);
    await expect(reconcileTenantTelemetryWriterForStartup(
      store,
      { ...config, TENANT_TELEMETRY_REF_KEY: "32".repeat(32) },
      { warn: () => {} },
    )).rejects.toThrow(/ref key does not match/);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    await store.close();
  });
});
