import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
  TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
  TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  TenantTelemetryApplicationCaptureConflictError,
  TenantTelemetryApplicationCaptureIntegrityError,
  type ActivateTenantTelemetryApplicationCaptureInput,
  type EnqueueTenantTelemetryArtifactInput,
  type TenantTelemetryDomain,
} from "../src/index.js";
import { trustedRunnerTelemetryRecord } from "./tenant-telemetry-adapter.fixture.js";

const D = (character: string): string => character.repeat(64);
const REF_KEY = new Uint8Array(32).fill(35);
const PRODUCER_PROTOCOL = "application-dual-write-v1";
const PRODUCER_CONTRACT_SHA256 = D("9");

const lifecycleActivation = () => ({
  expectedControlGeneration: 0 as const,
  targets: [
    {
      domain: "logs" as const,
      backendKind: "memory",
      adapterProtocol: "telemetry-memory-v1",
      namespaceSha256: D("1"),
      failureDomainSha256: D("2"),
    },
    {
      domain: "traces" as const,
      backendKind: "memory",
      adapterProtocol: "telemetry-memory-v1",
      namespaceSha256: D("3"),
      failureDomainSha256: D("4"),
    },
  ],
});

async function captureActivation(
  store: MemorySessionStore,
  domain: TenantTelemetryDomain,
  producerContractSha256 = PRODUCER_CONTRACT_SHA256,
): Promise<ActivateTenantTelemetryApplicationCaptureInput> {
  const control = await store.getTenantTelemetryLifecycleControl();
  if (control.state !== "active") throw new Error("fixture lifecycle is inactive");
  const target = (await store.listTenantTelemetryLifecycleTargets())
    .find((candidate) => candidate.domain === domain);
  if (!target) throw new Error("fixture target is missing");
  return {
    domain,
    expectedControlGeneration: 0,
    expectedLifecycleControlGeneration: 1,
    lifecycleControlEvidenceSha256: control.activationEvidenceSha256,
    lifecycleTargetSha256: target.targetSha256,
    lifecycleTargetReceiptSha256: target.receiptSha256,
    producerProtocol: PRODUCER_PROTOCOL,
    producerContractSha256,
    fleetStoppedAck: TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
    legacyWritersDrainedAck:
      TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
    producerReadyAck: TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  };
}

function writeInput(
  tenantId: string,
  artifactCharacter: string,
  domain: TenantTelemetryDomain = "logs",
  producerBound = false,
): EnqueueTenantTelemetryArtifactInput {
  return {
    tenantId,
    expectedControlGeneration: 1,
    domain,
    artifactIdSha256: D(artifactCharacter),
    artifactGeneration: 1,
    ownerKind: "tenant",
    ownerId: tenantId,
    ownerUserId: null,
    sourceSchema: "structured-log-batch-v1",
    sourceGeneration: 1,
    sourceHighWaterDbMs: 1_100,
    ...(producerBound ? {
      producerProtocol: PRODUCER_PROTOCOL,
      producerContractSha256: PRODUCER_CONTRACT_SHA256,
    } : {}),
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain,
      records: [trustedRunnerTelemetryRecord(1_100, {
        opaqueRefKey: REF_KEY,
        tenantValue: tenantId,
        ownerKind: "tenant",
        ownerValue: tenantId,
      })],
    },
  };
}

describe("MemorySessionStore tenant telemetry application capture", () => {
  it("is independently dormant for logs and traces", async () => {
    const store = new MemorySessionStore(
      { now: () => 1_000 },
      { tenantTelemetryRefKey: REF_KEY },
    );
    await expect(store.listTenantTelemetryApplicationDomainControls()).resolves.toEqual([
      { domain: "logs", state: "inactive", controlGeneration: 0 },
      { domain: "traces", state: "inactive", controlGeneration: 0 },
    ]);
    await expect(store.getTenantTelemetryApplicationActivationReceipt("logs"))
      .resolves.toBeNull();
    await expect(store.getTenantTelemetryApplicationCoverage("missing", "logs"))
      .resolves.toBeNull();
  });

  it("atomically activates one domain for legacy tenants and exact-replays only that request", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: REF_KEY },
    );
    await store.createApiKey("capture-legacy", "key", "hash");
    nowMs = 2_000;
    await store.activateTenantTelemetryLifecycle(lifecycleActivation());
    nowMs = 3_000;
    const activation = await captureActivation(store, "logs");
    const first = await store.activateTenantTelemetryApplicationCapture(activation);

    expect(first.control).toMatchObject({
      domain: "logs",
      state: "active",
      controlGeneration: 1,
      coverageCount: 1,
      preCutoverWriteCount: 0,
      activatedAtDbMs: 3_000,
    });
    await expect(store.getTenantTelemetryApplicationCoverage("capture-legacy", "logs"))
      .resolves.toMatchObject({
        captureStatus: "capture_since_cutover",
        preCutoverHistoryStatus: "pre_cutover_history_unknown",
        lifecycleHistoryStatus: "legacy_history_unknown",
        coverageStartedAtDbMs: 3_000,
      });
    await expect(store.getTenantTelemetryApplicationDomainControl("traces"))
      .resolves.toEqual({ domain: "traces", state: "inactive", controlGeneration: 0 });
    await expect(store.getTenantTelemetryApplicationCoverage("capture-legacy", "traces"))
      .resolves.toBeNull();

    await expect(Promise.all([
      store.activateTenantTelemetryApplicationCapture(activation),
      store.activateTenantTelemetryApplicationCapture(activation),
    ])).resolves.toEqual([first, first]);
    await expect(store.activateTenantTelemetryApplicationCapture({
      ...activation,
      producerContractSha256: D("8"),
    })).rejects.toBeInstanceOf(TenantTelemetryApplicationCaptureConflictError);
  });

  it("supports a separate traces cutover without implicitly activating it", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: REF_KEY },
    );
    await store.activateTenantTelemetryLifecycle(lifecycleActivation());
    await store.activateTenantTelemetryApplicationCapture(
      await captureActivation(store, "logs"),
    );
    await expect(store.getTenantTelemetryApplicationDomainControl("traces"))
      .resolves.toMatchObject({ state: "inactive", controlGeneration: 0 });
    nowMs = 1_100;
    const traces = await store.activateTenantTelemetryApplicationCapture(
      await captureActivation(store, "traces", D("7")),
    );
    expect(traces.control).toMatchObject({
      domain: "traces",
      state: "active",
      producerContractSha256: D("7"),
    });
  });

  it("creates all active-domain coverage in the same boundary as a new tenant", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: REF_KEY },
    );
    await store.activateTenantTelemetryLifecycle(lifecycleActivation());
    await store.activateTenantTelemetryApplicationCapture(
      await captureActivation(store, "logs"),
    );
    nowMs = 1_100;
    await store.createApiKey("capture-new", "key", "hash-new");
    await expect(store.getTenantTelemetryApplicationCoverage("capture-new", "logs"))
      .resolves.toMatchObject({
        captureStatus: "capture_since_tenant_creation",
        preCutoverHistoryStatus: "pre_cutover_not_applicable",
        lifecycleHistoryStatus: "complete_since_creation",
        coverageStartedAtDbMs: 1_100,
      });
    await expect(store.getTenantTelemetryApplicationCoverage("capture-new", "traces"))
      .resolves.toBeNull();

    const originalSet = store.tenantTelemetryApplicationCoverages.set.bind(
      store.tenantTelemetryApplicationCoverages,
    );
    let fail = true;
    Object.defineProperty(store.tenantTelemetryApplicationCoverages, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof originalSet>[1]) => {
        if (fail) {
          fail = false;
          throw new Error("injected application coverage publication failure");
        }
        return originalSet(key, value);
      },
    });
    nowMs = 1_200;
    await expect(store.createApiKey("capture-rollback", "key", "hash-rollback"))
      .rejects.toThrow("injected application coverage publication failure");
    await expect(store.getTenant("capture-rollback")).resolves.toBeNull();
    await expect(store.resolveApiKey("hash-rollback")).resolves.toBeNull();
    expect(store.tenantTelemetryLifecycleCoverages.has("capture-rollback")).toBe(false);
    expect([...store.tenantTelemetryApplicationCoverages.values()]
      .some((coverage) => coverage.tenantId === "capture-rollback")).toBe(false);
  });

  it("rolls back control, receipt, and every coverage when activation publication fails", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: REF_KEY },
    );
    await store.createApiKey("capture-activation-rollback", "key", "hash");
    nowMs = 2_000;
    await store.activateTenantTelemetryLifecycle(lifecycleActivation());
    const activation = await captureActivation(store, "logs");
    const originalSet = store.tenantTelemetryApplicationCoverages.set.bind(
      store.tenantTelemetryApplicationCoverages,
    );
    let fail = true;
    Object.defineProperty(store.tenantTelemetryApplicationCoverages, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof originalSet>[1]) => {
        if (fail) {
          fail = false;
          throw new Error("injected application activation failure");
        }
        return originalSet(key, value);
      },
    });
    await expect(store.activateTenantTelemetryApplicationCapture(activation))
      .rejects.toThrow("injected application activation failure");
    await expect(store.getTenantTelemetryApplicationDomainControl("logs"))
      .resolves.toEqual({ domain: "logs", state: "inactive", controlGeneration: 0 });
    expect(store.tenantTelemetryApplicationActivationReceipts).toHaveLength(0);
    expect(store.tenantTelemetryApplicationCoverages).toHaveLength(0);
  });

  it("freezes pre-cutover jobs unbound and atomically binds every post-cutover enqueue", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: REF_KEY },
    );
    await store.activateTenantTelemetryLifecycle(lifecycleActivation());
    nowMs = 1_100;
    const tenantId = "capture-write-binding";
    await store.createApiKey(tenantId, "key", "hash");
    await expect(store.enqueueTenantTelemetryArtifact(
      writeInput(tenantId, "4", "logs", true),
    )).rejects.toThrow(/requires an active cutover/);
    const before = await store.enqueueTenantTelemetryArtifact(writeInput(tenantId, "5"));
    await expect(store.getTenantTelemetryApplicationWriteBinding(
      tenantId,
      before.writeOperationSha256,
    )).resolves.toBeNull();

    nowMs = 1_200;
    const activated = await store.activateTenantTelemetryApplicationCapture(
      await captureActivation(store, "logs"),
    );
    expect(activated.control.preCutoverWriteCount).toBe(1);
    await expect(store.enqueueTenantTelemetryArtifact(writeInput(tenantId, "5")))
      .resolves.toEqual(before);
    await expect(store.getTenantTelemetryApplicationWriteBinding(
      tenantId,
      before.writeOperationSha256,
    )).resolves.toBeNull();

    nowMs = 1_300;
    await expect(store.enqueueTenantTelemetryArtifact(writeInput(tenantId, "6")))
      .rejects.toThrow(/producer contract/);
    await expect(store.registerTenantTelemetryArtifact({
      tenantId,
      expectedControlGeneration: 1,
      domain: "logs",
      artifactIdSha256: D("a"),
      artifactGeneration: 1,
      ownerKind: "tenant",
      ownerId: tenantId,
      ownerUserId: null,
      sourceSchema: "structured-log-batch-v1",
      sourceGeneration: 1,
      sourceHighWaterDbMs: nowMs,
      payloadSha256: D("b"),
      manifestSha256: D("c"),
    })).rejects.toBeInstanceOf(TenantTelemetryApplicationCaptureConflictError);
    const after = await store.enqueueTenantTelemetryArtifact(
      writeInput(tenantId, "6", "logs", true),
    );
    await expect(store.getTenantTelemetryApplicationWriteBinding(
      tenantId,
      after.writeOperationSha256,
    )).resolves.toMatchObject({
      tenantId,
      domain: "logs",
      writeOperationSha256: after.writeOperationSha256,
      controlEvidenceSha256: activated.control.activationEvidenceSha256,
      inventorySha256: after.inventory.inventorySha256,
      manifestSha256: after.inventory.manifestSha256,
      payloadSha256: after.inventory.payloadSha256,
    });
    await expect(store.getTenantTelemetryApplicationWriteBinding(
      "another-tenant",
      after.writeOperationSha256,
    )).resolves.toBeNull();
  });

  it("binds post-cutover writes without rewriting legacy lifecycle history", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: REF_KEY },
    );
    const tenantId = "capture-legacy-lifecycle-write";
    await store.createApiKey(tenantId, "key", "hash");
    nowMs = 2_000;
    await store.activateTenantTelemetryLifecycle(lifecycleActivation());
    await expect(store.getTenantTelemetryLifecycleCoverage(tenantId)).resolves.toMatchObject({
      historyStatus: "legacy_history_unknown",
    });
    nowMs = 3_000;
    await store.activateTenantTelemetryApplicationCapture(
      await captureActivation(store, "logs"),
    );
    await expect(store.getTenantTelemetryApplicationCoverage(tenantId, "logs"))
      .resolves.toMatchObject({
        captureStatus: "capture_since_cutover",
        lifecycleHistoryStatus: "legacy_history_unknown",
      });

    nowMs = 4_000;
    const queued = await store.enqueueTenantTelemetryArtifact(
      writeInput(tenantId, "d", "logs", true),
    );
    expect(queued.inventory.historyStatus).toBe("legacy_history_unknown");
    await expect(store.getTenantTelemetryApplicationWriteBinding(
      tenantId,
      queued.writeOperationSha256,
    )).resolves.toMatchObject({
      tenantId,
      writeOperationSha256: queued.writeOperationSha256,
      lifecycleCoverageEvidenceSha256: queued.inventory.coverageEvidenceSha256,
    });
  });

  it("rolls back job and payload when the post-cutover binding cannot publish", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: REF_KEY },
    );
    await store.activateTenantTelemetryLifecycle(lifecycleActivation());
    await store.activateTenantTelemetryApplicationCapture(
      await captureActivation(store, "logs"),
    );
    nowMs = 1_100;
    const tenantId = "capture-write-rollback";
    await store.createApiKey(tenantId, "key", "hash");
    const originalSet = store.tenantTelemetryApplicationWriteBindings.set.bind(
      store.tenantTelemetryApplicationWriteBindings,
    );
    Object.defineProperty(store.tenantTelemetryApplicationWriteBindings, "set", {
      configurable: true,
      value: () => {
        throw new Error("injected write binding publication failure");
      },
    });
    await expect(store.enqueueTenantTelemetryArtifact(
      writeInput(tenantId, "7", "logs", true),
    ))
      .rejects.toThrow("injected write binding publication failure");
    expect(store.tenantTelemetryWriteJobs).toHaveLength(0);
    expect(store.tenantTelemetryWritePayloads).toHaveLength(0);
    expect(store.tenantTelemetryApplicationWriteBindings).toHaveLength(0);
    Object.defineProperty(store.tenantTelemetryApplicationWriteBindings, "set", {
      configurable: true,
      value: originalSet,
    });
  });

  it("fails closed when an active domain loses a tenant or write binding", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: REF_KEY },
    );
    await store.activateTenantTelemetryLifecycle(lifecycleActivation());
    await store.activateTenantTelemetryApplicationCapture(
      await captureActivation(store, "logs"),
    );
    nowMs = 1_100;
    const tenantId = "capture-integrity";
    await store.createApiKey(tenantId, "key", "hash");
    const job = await store.enqueueTenantTelemetryArtifact(
      writeInput(tenantId, "8", "logs", true),
    );
    store.tenantTelemetryApplicationWriteBindings.delete(job.writeOperationSha256);
    await expect(store.getTenantTelemetryApplicationDomainControl("logs"))
      .rejects.toBeInstanceOf(TenantTelemetryApplicationCaptureIntegrityError);
  });
});
