import { describe, expect, it, vi } from "vitest";
import {
  HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
  HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  HttpTenantTelemetryWriteAdapter,
  MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  MemorySessionStore,
  MemoryTenantTelemetryWriteAdapter,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  TenantTelemetryWriteAdapterTemporaryError,
  newErasureRequestId,
  tenantErasureRequestHash,
  tenantTelemetryWriteAdapterResult,
  type HttpTenantTelemetryWriteRequest,
  type TenantTelemetryWriteAdapter,
  type TenantTelemetryWriteAdapterInput,
  type TenantTelemetryWriteAdapterResult,
} from "@agent-service/store";
import {
  createStructuredTelemetry,
  type StructuredTelemetryRecord,
} from "@agent-service/protocol";
import { TenantTelemetryWriterWorker } from "../src/index.js";

const D = (character: string) => character.repeat(64);
const REF_KEY = new Uint8Array(32).fill(22);

function trustedRecord(
  timestampMs: number,
  ownerKind: "tenant" | "user" | "session",
  ownerId: string,
): Readonly<StructuredTelemetryRecord> {
  let record: Readonly<StructuredTelemetryRecord> | undefined;
  const telemetry = createStructuredTelemetry({
    component: "runner",
    opaqueRefKey: REF_KEY,
    now: () => timestampMs,
    sink: { write(value) { record = value; } },
  });
  telemetry.info("runner.runtime.info", {
    ownerRef: telemetry.opaqueRef(ownerKind, ownerId),
    retryable: true,
  });
  if (!record) throw new Error("trusted telemetry fixture did not emit a record");
  return record;
}

async function fixture(): Promise<{
  store: MemorySessionStore;
  tenantId: string;
  writeOperationSha256: string;
  input: TenantTelemetryWriteAdapterInput;
  setNow(value: number): void;
}> {
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
        namespaceSha256: D("1"),
        failureDomainSha256: D("2"),
      },
      {
        domain: "traces",
        backendKind: "fixture",
        adapterProtocol: MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
        namespaceSha256: D("3"),
        failureDomainSha256: D("4"),
      },
    ],
  });
  nowMs = 1_100;
  const tenantId = "telemetry-writer-worker-tenant";
  await store.createApiKey(tenantId, "telemetry-writer-key", "hash");
  const job = await store.enqueueTenantTelemetryArtifact({
    tenantId,
    expectedControlGeneration: 1,
    domain: "logs",
    artifactIdSha256: D("5"),
    artifactGeneration: 1,
    ownerKind: "tenant",
    ownerId: tenantId,
    ownerUserId: null,
    sourceSchema: "structured-log-batch-v1",
    sourceGeneration: 1,
    sourceHighWaterDbMs: nowMs,
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs",
      records: [trustedRecord(nowMs, "tenant", tenantId)],
    },
  });
  const payload = store.tenantTelemetryWritePayloads.get(job.writeOperationSha256);
  if (!payload) throw new Error("telemetry writer fixture payload is missing");
  return {
    store,
    tenantId,
    writeOperationSha256: job.writeOperationSha256,
    input: {
      writeOperationSha256: job.writeOperationSha256,
      target: job.target,
      inventory: job.inventory,
      payload: payload.payload,
    },
    setNow(value: number) { nowMs = value; },
  };
}

function worker(
  store: MemorySessionStore,
  adapter: TenantTelemetryWriteAdapter,
  logger?: Pick<Console, "warn">,
): TenantTelemetryWriterWorker {
  return new TenantTelemetryWriterWorker({ store, adapter, logger }, {
    batchSize: 1,
    leaseMs: 1_000,
    retryBaseMs: 10,
    retryMaxMs: 100,
  });
}

describe("TenantTelemetryWriterWorker", () => {
  it("claims, inspects, creates, and atomically records the terminal write ACK", async () => {
    const state = await fixture();
    const adapter = new MemoryTenantTelemetryWriteAdapter({ nonProductionFixture: true });
    const instance = worker(state.store, adapter);

    await expect(instance.processOnce()).resolves.toBe(1);
    await expect(state.store.getTenantTelemetryWriteJob(
      state.tenantId,
      state.writeOperationSha256,
    )).resolves.toMatchObject({ phase: "written", attempts: 1 });
    await expect(state.store.getTenantTelemetryWriteAck(
      state.tenantId,
      state.writeOperationSha256,
    )).resolves.toMatchObject({ outcome: "written", replayed: false });
    expect(state.store.tenantTelemetryWritePayloads.has(state.writeOperationSha256)).toBe(false);
    await instance.stop();
  });

  it("closes a committed-create response-loss window with exact inspection and no second create", async () => {
    const state = await fixture();
    let commits = 0;
    const adapter = new MemoryTenantTelemetryWriteAdapter({
      nonProductionFixture: true,
      afterWriteCommit: () => {
        commits += 1;
        throw new Error("response lost after sink commit with secret locator");
      },
    });
    const logger = { warn: vi.fn() };
    const instance = worker(state.store, adapter, logger);

    await expect(instance.processOnce()).resolves.toBe(1);
    expect(commits).toBe(1);
    await expect(state.store.getTenantTelemetryWriteAck(
      state.tenantId,
      state.writeOperationSha256,
    )).resolves.toMatchObject({ outcome: "already_present", replayed: true });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret locator");
    await instance.stop();
  });

  it.each(["malformed", "oversized", "unbound"] as const)(
    "recovers a committed HTTP create after a %s success response by exact inspection",
    async (failureMode) => {
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
            adapterProtocol: HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
            namespaceSha256: D("1"),
            failureDomainSha256: D("2"),
          },
          {
            domain: "traces",
            backendKind: "fixture",
            adapterProtocol: HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
            namespaceSha256: D("3"),
            failureDomainSha256: D("4"),
          },
        ],
      });
      nowMs = 1_100;
      const tenantId = `telemetry-http-${failureMode}-tenant`;
      await store.createApiKey(tenantId, `telemetry-http-${failureMode}-key`, "hash");
      const job = await store.enqueueTenantTelemetryArtifact({
        tenantId,
        expectedControlGeneration: 1,
        domain: "logs",
        artifactIdSha256: D("5"),
        artifactGeneration: 1,
        ownerKind: "tenant",
        ownerId: tenantId,
        ownerUserId: null,
        sourceSchema: "structured-log-batch-v1",
        sourceGeneration: 1,
        sourceHighWaterDbMs: nowMs,
        payload: {
          schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
          domain: "logs",
          records: [trustedRecord(nowMs, "tenant", tenantId)],
        },
      });
      const payload = store.tenantTelemetryWritePayloads.get(job.writeOperationSha256);
      if (!payload) throw new Error("telemetry HTTP worker fixture payload is missing");
      const input: TenantTelemetryWriteAdapterInput = {
        writeOperationSha256: job.writeOperationSha256,
        target: job.target,
        inventory: job.inventory,
        payload: payload.payload,
      };
      let committed = false;
      let creates = 0;
      let inspections = 0;
      const response = (value: unknown, status = 200): Response => new Response(
        JSON.stringify(value),
        { status, headers: { "content-type": "application/json" } },
      );
      const fetchImpl = (async (_request: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body ?? "")) as HttpTenantTelemetryWriteRequest;
        if (request.action === "inspect") {
          inspections += 1;
          return response(committed ? {
            protocol: HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
            targetSha256: input.target.targetSha256,
            targetReceiptSha256: input.target.receiptSha256,
            status: "exact",
            result: tenantTelemetryWriteAdapterResult(
              HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
              input,
              "already_present",
              true,
            ),
          } : {
            protocol: HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
            targetSha256: input.target.targetSha256,
            targetReceiptSha256: input.target.receiptSha256,
            status: "absent",
          });
        }
        creates += 1;
        committed = true;
        if (failureMode === "oversized") {
          return response({ padding: "x".repeat(2_000) }, 201);
        }
        return response({
          protocol: HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
          targetSha256: input.target.targetSha256,
          targetReceiptSha256: failureMode === "unbound"
            ? D("f")
            : input.target.receiptSha256,
          status: "exact",
          result: failureMode === "malformed"
            ? { credential: "must-not-be-accepted" }
            : tenantTelemetryWriteAdapterResult(
              HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
              input,
              "written",
              false,
            ),
        }, 201);
      }) as typeof fetch;
      const adapter = new HttpTenantTelemetryWriteAdapter({
        endpointUrl: "http://127.0.0.1:4318/collector",
        expectedTargets: [{
          targetSha256: input.target.targetSha256,
          targetReceiptSha256: input.target.receiptSha256,
        }],
        allowInsecureHttpForLocalTest: true,
        maxResponseBytes: 1_024,
        fetchImpl,
      });
      const instance = worker(store, adapter);

      await expect(instance.processOnce()).resolves.toBe(1);
      expect(creates).toBe(1);
      expect(inspections).toBe(3);
      await expect(store.getTenantTelemetryWriteAck(
        tenantId,
        job.writeOperationSha256,
      )).resolves.toMatchObject({ outcome: "already_present", replayed: true });
      await expect(store.getTenantTelemetryWriteJob(
        tenantId,
        job.writeOperationSha256,
      )).resolves.toMatchObject({ phase: "written" });
      await instance.stop();
    },
  );

  it("blocks a pre-existing exact remote object when no durable reservation exists", async () => {
    const state = await fixture();
    const adapter = new MemoryTenantTelemetryWriteAdapter({ nonProductionFixture: true });
    await adapter.createWrite(state.input);
    const instance = worker(state.store, adapter);

    await expect(instance.processOnce()).resolves.toBe(0);
    await expect(state.store.getTenantTelemetryWriteJob(
      state.tenantId,
      state.writeOperationSha256,
    )).resolves.toMatchObject({ phase: "blocked", blockedReasonCode: "integrity_conflict" });
    await expect(state.store.getTenantTelemetryWriteAck(
      state.tenantId,
      state.writeOperationSha256,
    )).resolves.toBeNull();
    await instance.stop();
  });

  it("finishes an exact reserved mutation when T1 commits after reservation but before create", async () => {
    const state = await fixture();
    const delegate = new MemoryTenantTelemetryWriteAdapter({ nonProductionFixture: true });
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let createStarted!: () => void;
    const createBegan = new Promise<void>((resolve) => { createStarted = resolve; });
    const adapter: TenantTelemetryWriteAdapter = {
      adapterProtocol: delegate.adapterProtocol,
      inspectWrite: (input) => delegate.inspectWrite(input),
      createWrite: async (input) => {
        createStarted();
        await createGate;
        return delegate.createWrite(input);
      },
      close: () => delegate.close(),
    };
    const instance = worker(state.store, adapter);
    const run = instance.processOnce();
    await createBegan;
    const reserved = await state.store.getTenantTelemetryWriteJob(
      state.tenantId, state.writeOperationSha256,
    );
    expect(reserved?.reservation).toBeDefined();
    state.setNow(1_200);
    await state.store.requestTenantErasure({
      requestId: newErasureRequestId(),
      tenantId: state.tenantId,
      requestedByKeyId: "worker-race",
      idempotencyKey: "worker-reserved-t1",
      requestHash: tenantErasureRequestHash(state.tenantId),
      atMs: 1_200,
    });
    releaseCreate();
    await expect(run).resolves.toBe(1);
    await expect(state.store.getTenantTelemetryWriteAck(
      state.tenantId, state.writeOperationSha256,
    )).resolves.toMatchObject({
      reservationReceiptSha256: reserved!.reservation!.receiptSha256,
    });
    await instance.stop();
  });

  it("does not create when T1 wins after the first inspect starts but before reservation", async () => {
    const state = await fixture();
    let releaseInspect!: () => void;
    const inspectGate = new Promise<void>((resolve) => { releaseInspect = resolve; });
    let inspectStarted!: () => void;
    const inspectBegan = new Promise<void>((resolve) => { inspectStarted = resolve; });
    let createCalls = 0;
    const adapter: TenantTelemetryWriteAdapter = {
      adapterProtocol: MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
      inspectWrite: async () => {
        inspectStarted();
        await inspectGate;
        return { status: "absent" };
      },
      createWrite: async () => {
        createCalls += 1;
        throw new Error("create must not run without reservation");
      },
      close: async () => {},
    };
    const instance = worker(state.store, adapter);
    const run = instance.processOnce();
    await inspectBegan;
    state.setNow(1_200);
    await state.store.requestTenantErasure({
      requestId: newErasureRequestId(),
      tenantId: state.tenantId,
      requestedByKeyId: "worker-race",
      idempotencyKey: "worker-unreserved-t1",
      requestHash: tenantErasureRequestHash(state.tenantId),
      atMs: 1_200,
    });
    releaseInspect();
    await expect(run).resolves.toBe(0);
    expect(createCalls).toBe(0);
    await expect(state.store.getTenantTelemetryWriteAck(
      state.tenantId, state.writeOperationSha256,
    )).resolves.toBeNull();
    const job = await state.store.getTenantTelemetryWriteJob(
      state.tenantId, state.writeOperationSha256,
    );
    expect(job).toMatchObject({ phase: "queued" });
    expect(job).not.toHaveProperty("reservation");
    await instance.stop();
  });

  it("replays an exact DB completion after its committed response is lost", async () => {
    const state = await fixture();
    const adapter = new MemoryTenantTelemetryWriteAdapter({ nonProductionFixture: true });
    const original = state.store.completeTenantTelemetryWrite.bind(state.store);
    let loseResponse = true;
    state.store.completeTenantTelemetryWrite = async (...args) => {
      const result = await original(...args);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("DB response loss with secret connection text");
      }
      return result;
    };
    const logger = { warn: vi.fn() };
    const instance = worker(state.store, adapter, logger);

    await expect(instance.processOnce()).resolves.toBe(1);
    await expect(state.store.getTenantTelemetryWriteAck(
      state.tenantId,
      state.writeOperationSha256,
    )).resolves.toMatchObject({ outcome: "written" });
    expect(logger.warn).not.toHaveBeenCalled();
    await instance.stop();
  });

  it("retries temporary failure and blocks immutable conflict even when warning logging throws", async () => {
    const temporaryState = await fixture();
    const temporaryLogger = { warn: vi.fn(() => {
      throw new Error("throwing logger must not alter retry");
    }) };
    const temporary: TenantTelemetryWriteAdapter = {
      adapterProtocol: MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
      inspectWrite: async () => ({ status: "absent" }),
      createWrite: async () => {
        throw new TenantTelemetryWriteAdapterTemporaryError();
      },
      close: async () => {},
    };
    const retrying = worker(temporaryState.store, temporary, temporaryLogger);
    await expect(retrying.processOnce()).resolves.toBe(0);
    await expect(temporaryState.store.getTenantTelemetryWriteJob(
      temporaryState.tenantId,
      temporaryState.writeOperationSha256,
    )).resolves.toMatchObject({
      phase: "queued",
      lastErrorCode: "temporary_failure",
      reservation: {
        adapterProtocol: MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
      },
    });
    expect(temporaryLogger.warn).toHaveBeenCalledWith(
      "[tenant-telemetry-writer-worker] write failed",
    );
    await retrying.stop();

    const conflictState = await fixture();
    const conflict: TenantTelemetryWriteAdapter = {
      adapterProtocol: MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
      inspectWrite: async () => ({ status: "conflict" }),
      createWrite: async () => { throw new Error("must not create after conflict"); },
      close: async () => {},
    };
    const conflictLogger = { warn: vi.fn(() => {
      throw new Error("throwing logger must not alter block");
    }) };
    const blocking = worker(conflictState.store, conflict, conflictLogger);
    await expect(blocking.processOnce()).resolves.toBe(0);
    await expect(conflictState.store.getTenantTelemetryWriteJob(
      conflictState.tenantId,
      conflictState.writeOperationSha256,
    )).resolves.toMatchObject({
      phase: "blocked",
      blockedReasonCode: "integrity_conflict",
    });
    expect(conflictLogger.warn).toHaveBeenCalledWith(
      "[tenant-telemetry-writer-worker] write failed",
    );
    await blocking.stop();
  });

  it("contains throwing warning loggers across claim, scheduled poll, and adapter close failures", async () => {
    const claimState = await fixture();
    claimState.store.claimTenantTelemetryWriteJobs = async () => {
      throw new Error("claim backend detail must remain contained");
    };
    const throwingLogger = { warn: vi.fn(() => {
      throw new Error("logger unavailable");
    }) };
    const claimWorker = worker(
      claimState.store,
      new MemoryTenantTelemetryWriteAdapter({ nonProductionFixture: true }),
      throwingLogger,
    );
    await expect(claimWorker.processOnce()).resolves.toBe(0);
    await expect(claimState.store.getTenantTelemetryWriteJob(
      claimState.tenantId,
      claimState.writeOperationSha256,
    )).resolves.toMatchObject({ phase: "queued", attempts: 0 });
    await expect(claimWorker.stop()).resolves.toBeUndefined();
    expect(throwingLogger.warn).toHaveBeenCalledWith(
      "[tenant-telemetry-writer-worker] claim failed",
    );

    vi.useFakeTimers();
    try {
      const scheduledState = await fixture();
      const close = vi.fn(async () => {
        throw new Error("adapter close backend detail must remain contained");
      });
      const adapter: TenantTelemetryWriteAdapter = {
        adapterProtocol: MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
        inspectWrite: async () => ({ status: "absent" }),
        createWrite: async () => { throw new Error("unused"); },
        close,
      };
      const scheduled = worker(scheduledState.store, adapter, throwingLogger);
      vi.spyOn(scheduled, "processOnce").mockRejectedValueOnce(
        new Error("unexpected poll failure"),
      );
      scheduled.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(throwingLogger.warn).toHaveBeenCalledWith(
        "[tenant-telemetry-writer-worker] polling failed",
      );
      await expect(scheduled.stop()).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
      expect(throwingLogger.warn).toHaveBeenCalledWith(
        "[tenant-telemetry-writer-worker] adapter close failed",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains an in-flight ambiguous write before closing the adapter", async () => {
    const state = await fixture();
    const delegate = new MemoryTenantTelemetryWriteAdapter({ nonProductionFixture: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const close = vi.fn(async () => delegate.close());
    const adapter: TenantTelemetryWriteAdapter = {
      adapterProtocol: delegate.adapterProtocol,
      inspectWrite: (input) => delegate.inspectWrite(input),
      createWrite: async (input: TenantTelemetryWriteAdapterInput):
      Promise<TenantTelemetryWriteAdapterResult> => {
        started();
        await gate;
        return delegate.createWrite(input);
      },
      close,
    };
    const instance = worker(state.store, adapter);
    const run = instance.processOnce();
    await began;
    const stopping = instance.stop();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    release();

    await expect(run).resolves.toBe(1);
    await expect(stopping).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(state.store.getTenantTelemetryWriteAck(
      state.tenantId,
      state.writeOperationSha256,
    )).resolves.toBeTruthy();
    await expect(instance.processOnce()).resolves.toBe(0);
  });
});
