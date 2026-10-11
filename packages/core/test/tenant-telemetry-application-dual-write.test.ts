import { describe, expect, it, vi } from "vitest";
import {
  assertTrustedStructuredTelemetryRecord,
  assertTrustedStructuredTelemetryRecordOwnerBinding,
  type StructuredTelemetryRecord,
} from "@agent-service/protocol";
import {
  MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  MemorySessionStore,
  TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
  TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
  TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  captureTrustedEnqueueTenantTelemetryArtifactInput,
  type EnqueueTenantTelemetryArtifactInput,
  type TenantTelemetryWriteJobRecord,
} from "@agent-service/store";
import {
  createTenantTelemetryApplicationDualWrite,
  TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256,
  TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL,
} from "../src/index.js";

const REF_KEY = new Uint8Array(32).fill(37);
const SEED = new Uint8Array(32).fill(91);
const TEST_PRODUCER = {
  producerProtocol: "test-application-telemetry-v1",
  producerContractSha256: "a".repeat(64),
} as const;

function captureStore(captured: EnqueueTenantTelemetryArtifactInput[]) {
  return {
    enqueueTenantTelemetryArtifact(input: EnqueueTenantTelemetryArtifactInput) {
      // Exercise the same live-admission boundary as Memory/MySQL before preserving the input for
      // assertions. A detached/literal record would fail here even if its JSON were valid.
      captureTrustedEnqueueTenantTelemetryArtifactInput(input, REF_KEY);
      captured.push(input);
      return Promise.resolve({} as TenantTelemetryWriteJobRecord);
    },
  };
}

describe("tenant telemetry application dual write", () => {
  it("atomically reaches the real Memory spool for a covered post-activation tenant", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: REF_KEY },
    );
    await store.activateTenantTelemetryLifecycle({
      expectedControlGeneration: 0,
      targets: [
        {
          domain: "logs",
          backendKind: "fixture",
          adapterProtocol: MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
          namespaceSha256: "1".repeat(64),
          failureDomainSha256: "2".repeat(64),
        },
        {
          domain: "traces",
          backendKind: "fixture",
          adapterProtocol: MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
          namespaceSha256: "3".repeat(64),
          failureDomainSha256: "4".repeat(64),
        },
      ],
    });
    const lifecycle = await store.getTenantTelemetryLifecycleControl();
    if (lifecycle.state !== "active") throw new Error("test lifecycle is inactive");
    const logsTarget = (await store.listTenantTelemetryLifecycleTargets())
      .find((target) => target.domain === "logs")!;
    await store.activateTenantTelemetryApplicationCapture({
      domain: "logs",
      expectedControlGeneration: 0,
      expectedLifecycleControlGeneration: 1,
      lifecycleControlEvidenceSha256: lifecycle.activationEvidenceSha256,
      lifecycleTargetSha256: logsTarget.targetSha256,
      lifecycleTargetReceiptSha256: logsTarget.receiptSha256,
      ...TEST_PRODUCER,
      fleetStoppedAck: TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
      legacyWritersDrainedAck: TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
      producerReadyAck: TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
    });
    nowMs = 1_100;
    await store.createApiKey("tenant-covered", "key-covered", "hash");
    const writer = createTenantTelemetryApplicationDualWrite({
      component: "runner",
      ...TEST_PRODUCER,
      opaqueRefKey: REF_KEY,
      processSink: { write() {} },
      store,
      durableEnabled: () => true,
      now: () => nowMs,
      artifactIdentitySeed: SEED,
    });

    await writer.info({
      tenantId: "tenant-covered",
      ownerKind: "tenant",
      ownerId: "tenant-covered",
      ownerUserId: null,
    }, "runner.runtime.info");
    await writer.drain();

    expect(writer.durableReady).toBe(true);
    expect(writer.failedCount).toBe(0);
    expect(store.tenantTelemetryWriteJobs.size).toBe(1);
    expect(store.tenantTelemetryWritePayloads.size).toBe(1);
    const [job] = [...store.tenantTelemetryWriteJobs.values()];
    expect(job).toMatchObject({
      tenantId: "tenant-covered",
      phase: "queued",
      recordCount: 1,
      inventory: { domain: "logs", ownerKind: "tenant" },
    });
  });

  it("is default-dormant and never grants direct process logging durable authority", async () => {
    const records: Readonly<StructuredTelemetryRecord>[] = [];
    const enqueued: EnqueueTenantTelemetryArtifactInput[] = [];
    const writer = createTenantTelemetryApplicationDualWrite({
      component: "runner",
      ...TEST_PRODUCER,
      opaqueRefKey: REF_KEY,
      processSink: { write: (record) => records.push(record) },
      store: captureStore(enqueued),
      now: () => 101,
      artifactIdentitySeed: SEED,
    });

    await writer.info({
      tenantId: "tenant-a",
      ownerKind: "tenant",
      ownerId: "tenant-a",
      ownerUserId: null,
    }, "runner.runtime.info", {
      errorKind: "unavailable",
      ownerRef: writer.telemetry.opaqueRef("tenant", "tenant-a"),
      subjectRef: writer.telemetry.opaqueRef("session", "session-a"),
      targetRef: writer.telemetry.opaqueRef("runner", "runner-a"),
    });
    writer.telemetry.warn("runner.runtime.warning");
    await writer.drain();

    expect(records).toHaveLength(2);
    expect(records[0]!.fields).toEqual({ errorKind: "unavailable" });
    expect(JSON.stringify(records[0])).not.toContain("oref_");
    expect(records[1]!.fields).toEqual({});
    expect(enqueued).toEqual([]);
  });

  it("captures the exact trusted record without an unmanaged process-log duplicate", async () => {
    const records: Readonly<StructuredTelemetryRecord>[] = [];
    const enqueued: EnqueueTenantTelemetryArtifactInput[] = [];
    const writer = createTenantTelemetryApplicationDualWrite({
      component: "provider",
      ...TEST_PRODUCER,
      opaqueRefKey: REF_KEY,
      processSink: { write: (record) => records.push(record) },
      store: captureStore(enqueued),
      durableEnabled: () => true,
      now: () => 202,
      artifactIdentitySeed: SEED,
    });

    await writer.warn({
      tenantId: "tenant-private",
      ownerKind: "tenant",
      ownerId: "tenant-private",
      ownerUserId: null,
    }, "provider.upstream_request_failed", { errorKind: "network" });
    await writer.drain();

    expect(enqueued).toHaveLength(1);
    const input = enqueued[0]!;
    const record = input.payload.records[0]!;
    expect(records).toEqual([]);
    expect(input).toMatchObject({
      tenantId: "tenant-private",
      expectedControlGeneration: 1,
      domain: "logs",
      artifactGeneration: 1,
      ownerKind: "tenant",
      ownerId: "tenant-private",
      ownerUserId: null,
      sourceSchema: "agent-service.telemetry.v1",
      sourceGeneration: 1,
      sourceHighWaterDbMs: 0,
      payload: { domain: "logs" },
    });
    expect(input.artifactIdSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(input.artifactIdSha256).not.toContain("tenant-private");
    expect(record.fields).toMatchObject({ errorKind: "network" });
    assertTrustedStructuredTelemetryRecord(record);
    expect(() => assertTrustedStructuredTelemetryRecordOwnerBinding(
      record,
      "tenant-private",
      "tenant",
      "tenant-private",
      REF_KEY,
    )).not.toThrow();
  });

  it("binds session records to both tenant and owner without displacing a target ref", async () => {
    const records: Readonly<StructuredTelemetryRecord>[] = [];
    const enqueued: EnqueueTenantTelemetryArtifactInput[] = [];
    const writer = createTenantTelemetryApplicationDualWrite({
      component: "runner",
      ...TEST_PRODUCER,
      opaqueRefKey: REF_KEY,
      processSink: { write: (record) => records.push(record) },
      store: captureStore(enqueued),
      durableEnabled: () => true,
      now: () => 303,
      artifactIdentitySeed: SEED,
    });
    const targetRef = writer.telemetry.opaqueRef("runner", "runner-a");

    await writer.warn({
      tenantId: "tenant-a",
      ownerKind: "session",
      ownerId: "session-a",
      ownerUserId: "user-a",
    }, "runner.runtime.warning", { targetRef });
    await writer.drain();

    expect(records).toEqual([]);
    const record = enqueued[0]!.payload.records[0]!;
    expect(record.fields.targetRef).toBe(targetRef);
    expect(() => assertTrustedStructuredTelemetryRecordOwnerBinding(
      record,
      "tenant-a",
      "session",
      "session-a",
      REF_KEY,
    )).not.toThrow();
    expect(enqueued[0]).toMatchObject({
      tenantId: "tenant-a",
      ownerKind: "session",
      ownerId: "session-a",
      ownerUserId: "user-a",
    });
  });

  it("suppresses owner-bearing process output until a failed enqueue exact-replays", async () => {
    const records: Readonly<StructuredTelemetryRecord>[] = [];
    const failures: string[] = [];
    const enqueue = vi.fn((_: EnqueueTenantTelemetryArtifactInput): Promise<
      TenantTelemetryWriteJobRecord
    > => Promise.reject(
        new Error("raw database failure for tenant-private"),
      ));
    const store = {
      enqueueTenantTelemetryArtifact: enqueue,
    };
    const writer = createTenantTelemetryApplicationDualWrite({
      component: "runner",
      ...TEST_PRODUCER,
      opaqueRefKey: REF_KEY,
      processSink: { write: (record) => records.push(record) },
      store,
      durableEnabled: () => true,
      onDurableFailure: (reason) => failures.push(reason),
      now: () => 404,
      artifactIdentitySeed: SEED,
    });

    await writer.error({
      tenantId: "tenant-private",
      ownerKind: "tenant",
      ownerId: "tenant-private",
      ownerUserId: null,
    }, "runner.runtime.error", { retryable: true });
    await expect(writer.drain()).resolves.toBeUndefined();

    expect(records).toHaveLength(0);
    expect(store.enqueueTenantTelemetryArtifact).toHaveBeenCalledTimes(1);
    expect(failures).toEqual(["enqueue_failed"]);
    expect(writer.durableReady).toBe(false);
    expect(writer.failedCount).toBe(1);
    expect(JSON.stringify(failures)).not.toContain("tenant-private");
    expect(JSON.stringify(records)).not.toContain("tenant-private");

    let resolveRetry!: (job: TenantTelemetryWriteJobRecord) => void;
    const retryResult = new Promise<TenantTelemetryWriteJobRecord>((resolve) => {
      resolveRetry = resolve;
    });
    enqueue.mockReturnValueOnce(retryResult);
    const firstRetry = writer.retryFailed();
    const overlappingRetry = writer.retryFailed();

    // Both callers must share the same exact replay attempt. In particular, a periodic retry must
    // not race a manual retry and enqueue the same owner-bearing record twice.
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1]![0]).toBe(enqueue.mock.calls[0]![0]);
    resolveRetry({} as TenantTelemetryWriteJobRecord);
    await Promise.all([firstRetry, overlappingRetry]);
    expect(writer.failedCount).toBe(0);
    expect(writer.durableReady).toBe(true);
    expect(records).toHaveLength(0);
  });

  it("keeps active owner capture independent from a throwing process-only sink", async () => {
    const enqueued: EnqueueTenantTelemetryArtifactInput[] = [];
    const processFailures: string[] = [];
    const writer = createTenantTelemetryApplicationDualWrite({
      component: "runner",
      ...TEST_PRODUCER,
      opaqueRefKey: REF_KEY,
      processSink: { write: () => { throw new Error("process sink failed"); } },
      store: captureStore(enqueued),
      durableEnabled: () => true,
      onProcessSinkFailure: () => processFailures.push("failed"),
      now: () => 505,
      artifactIdentitySeed: SEED,
    });

    await expect(writer.info({
      tenantId: "tenant-a",
      ownerKind: "user",
      ownerId: "user-a",
      ownerUserId: "user-a",
    }, "runner.runtime.info")).resolves.toBeUndefined();
    await writer.drain();

    expect(enqueued).toHaveLength(1);
    expect(processFailures).toEqual([]);
    expect(() => assertTrustedStructuredTelemetryRecordOwnerBinding(
      enqueued[0]!.payload.records[0],
      "tenant-a",
      "user",
      "user-a",
      REF_KEY,
    )).not.toThrow();

    writer.telemetry.info("runner.runtime.info");
    expect(processFailures).toEqual(["failed"]);
  });

  it("never persists cross-owner refs and keeps an exact failed admission unhealthy", async () => {
    const records: Readonly<StructuredTelemetryRecord>[] = [];
    const enqueued: EnqueueTenantTelemetryArtifactInput[] = [];
    const failures: string[] = [];
    const writer = createTenantTelemetryApplicationDualWrite({
      component: "runner",
      ...TEST_PRODUCER,
      opaqueRefKey: REF_KEY,
      processSink: { write: (record) => records.push(record) },
      store: captureStore(enqueued),
      durableEnabled: () => true,
      onDurableFailure: (reason) => failures.push(reason),
      now: () => 606,
      artifactIdentitySeed: SEED,
    });
    const crossOwner = writer.telemetry.opaqueRef("user", "user-b");

    await writer.warn({
      tenantId: "tenant-a",
      ownerKind: "session",
      ownerId: "session-a",
      ownerUserId: "user-a",
    }, "runner.runtime.warning", { targetRef: crossOwner });
    await writer.drain();
    expect(enqueued).toEqual([]);
    expect(failures).toEqual(["enqueue_failed"]);
    expect(writer.durableReady).toBe(false);
    expect(records).toHaveLength(0);

    // The exact rejected input remains retryable. Later records may be captured, but they cannot
    // hide the unresolved gap or heal readiness.
    await writer.info({
      tenantId: "tenant-a",
      ownerKind: "tenant",
      ownerId: "tenant-a",
      ownerUserId: null,
    }, "runner.runtime.info");
    expect(enqueued).toHaveLength(1);
    expect(failures).toEqual(["enqueue_failed"]);
    expect(writer.failedCount).toBe(1);
    expect(writer.durableReady).toBe(false);

    await writer.close();
    expect(writer.durableReady).toBe(false);
    await writer.info({
      tenantId: "tenant-a",
      ownerKind: "tenant",
      ownerId: "tenant-a",
      ownerUserId: null,
    }, "runner.runtime.info");
    await writer.drain();
    expect(enqueued).toHaveLength(1);
    expect(failures).toEqual(["enqueue_failed", "writer_closed"]);
    expect(records).toHaveLength(0);
  });

  it("fails closed when an emission is outside the activated provider contract", async () => {
    const enqueued: EnqueueTenantTelemetryArtifactInput[] = [];
    expect(() => createTenantTelemetryApplicationDualWrite({
      component: "runner",
      producerProtocol: TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL,
      producerContractSha256: TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256,
      opaqueRefKey: REF_KEY,
      processSink: { write() {} },
      store: captureStore(enqueued),
    })).toThrow(/producer contract is inconsistent/);

    const failures: string[] = [];
    const writer = createTenantTelemetryApplicationDualWrite({
      component: "provider",
      producerProtocol: TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL,
      producerContractSha256: TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256,
      opaqueRefKey: REF_KEY,
      processSink: { write() {} },
      store: captureStore(enqueued),
      durableEnabled: () => true,
      onDurableFailure: (reason) => failures.push(reason),
    });
    await writer.warn({
      tenantId: "tenant-a",
      ownerKind: "user",
      ownerId: "user-a",
      ownerUserId: "user-a",
    }, "provider.upstream_request_failed");
    expect(enqueued).toEqual([]);
    expect(failures).toEqual(["enqueue_failed"]);
    expect(writer.durableReady).toBe(false);

    await writer.warn({
      tenantId: "tenant-a",
      ownerKind: "tenant",
      ownerId: "tenant-a",
      ownerUserId: null,
    }, "provider.upstream_request_failed");
    expect(enqueued).toEqual([]);
    expect(failures).toEqual(["enqueue_failed"]);
    expect(writer.durableReady).toBe(false);
  });
});
