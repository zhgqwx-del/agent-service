import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  TENANT_CREDENTIAL_TARGET_EXECUTION_TARGET_SCOPE,
  tenantCredentialTargetExecutionOperationIdSha256,
  tenantCredentialTargetExecutionTargetRootSha256,
  tenantCredentialTargetExecutionTargetSha256,
  type ClaimTenantCredentialTargetExecutionsOptions,
  type TenantCredentialTargetExecutionAdapter,
  type TenantCredentialTargetExecutionAdapterResult,
  type TenantCredentialTargetExecutionClaim,
  type TenantCredentialTargetExecutionEncryptedReference,
  type TenantCredentialTargetExecutionStore,
  type TenantCredentialTargetExecutionTarget,
} from "@agent-service/store";
import {
  createFakeCredentialTargetExecutionAdapterState,
  FakeCredentialTargetExecutionAdapter,
  queueFakeCredentialTargetExecutionFault,
  TenantCredentialTargetExecutionWorker,
} from "../src/index.js";

const REQUEST_ID = "erase_12345678-1234-4123-8123-123456789abc";
const PROTOCOL = "fake-external-credential-revoke-v1";
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function targetFixture(): {
  target: TenantCredentialTargetExecutionTarget;
  reference: TenantCredentialTargetExecutionEncryptedReference;
} {
  const cipher = new TextEncoder().encode("never-log-or-persist-this-reference");
  const identity = {
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 2,
    targetExecutionGeneration: 1,
  };
  const operationIdSha256 = tenantCredentialTargetExecutionOperationIdSha256({
    identity,
    credentialVersionId: A,
    domain: "external_credential",
    targetDispositionEvidenceSha256: B,
    adapterProtocol: PROTOCOL,
    targetReferenceCipherSha256: sha256(cipher),
    targetReferenceKeyId: "local-test-key-v1",
    targetReferenceSha256: C,
  });
  const body = {
    ...identity,
    scope: TENANT_CREDENTIAL_TARGET_EXECUTION_TARGET_SCOPE,
    targetOrdinal: 0,
    credentialVersionId: A,
    domain: "external_credential" as const,
    sourceDisposition: "executable_ref" as const,
    targetDispositionEvidenceSha256: B,
    adapterProtocol: PROTOCOL,
    targetReferenceCipherSha256: sha256(cipher),
    targetReferenceKeyId: "local-test-key-v1",
    targetReferenceSha256: C,
    operationIdSha256,
    capturedAtDbMs: 1_000,
  };
  const target: TenantCredentialTargetExecutionTarget = {
    ...body,
    receiptSha256: tenantCredentialTargetExecutionTargetSha256(body),
  };
  return {
    target,
    reference: {
      tenantId: target.tenantId,
      credentialVersionId: target.credentialVersionId,
      domain: "external_credential",
      adapterProtocol: target.adapterProtocol,
      targetDispositionEvidenceSha256: target.targetDispositionEvidenceSha256,
      targetReferenceCipher: cipher,
      targetReferenceCipherSha256: target.targetReferenceCipherSha256,
      targetReferenceKeyId: target.targetReferenceKeyId,
      targetReferenceSha256: target.targetReferenceSha256,
    },
  };
}

function makeClaim(
  input: ClaimTenantCredentialTargetExecutionsOptions,
  target: TenantCredentialTargetExecutionTarget,
): TenantCredentialTargetExecutionClaim {
  return {
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 2,
    targetExecutionGeneration: 1,
    t3aReceiptSha256: A,
    inventoryReceiptSha256: B,
    trackingCutoverEvidenceSha256: C,
    versionCount: 1,
    versionRootSha256: A,
    targetDispositionCount: 2,
    targetDispositionRootSha256: B,
    externalCredentialTargetCount: 1,
    externalCredentialTargetRootSha256: C,
    externalCredentialBlockerCount: 0,
    kmsKeyBlockerCount: 1,
    kmsKeyExecutableTargetCount: 0,
    sourceEvidenceDbMs: 1_000,
    phase: "queued",
    claimAttempt: 2,
    claimToken: input.claimToken,
    leaseUntilMs: 100_000,
    targetCount: 1,
    targetRootSha256: tenantCredentialTargetExecutionTargetRootSha256([target]),
  };
}

function fixture(options: { traceAdapter?: boolean } = {}) {
  const trace: string[] = [];
  const { target, reference } = targetFixture();
  const acks = new Set<number>();
  const materialize = vi.fn(async () => { trace.push("materialize"); return 1; });
  const claimJobs = vi.fn(async (input: ClaimTenantCredentialTargetExecutionsOptions) => {
    trace.push("claim");
    return [makeClaim(input, target)];
  });
  const renew = vi.fn(async () => { trace.push("renew"); return true; });
  const retry = vi.fn(async () => { trace.push("retry"); return true; });
  const block = vi.fn(async () => { trace.push("block"); return true; });
  const recordAck = vi.fn(async (_authorization, result: TenantCredentialTargetExecutionAdapterResult) => {
    trace.push("ack");
    if (result.operationIdSha256 === target.operationIdSha256) acks.add(target.targetOrdinal);
    return { targetOrdinal: target.targetOrdinal } as never;
  });
  const seal = vi.fn(async () => { trace.push("seal"); return { receiptSha256: A } as never; });
  const store: TenantCredentialTargetExecutionStore = {
    materializeTenantCredentialTargetExecutionJobs: materialize,
    claimTenantCredentialTargetExecutions: claimJobs,
    renewTenantCredentialTargetExecution: renew,
    retryTenantCredentialTargetExecution: retry,
    blockTenantCredentialTargetExecution: block,
    getTenantCredentialTargetExecutionReference: vi.fn(async () => {
      trace.push("reference");
      return reference;
    }),
    recordTenantCredentialTargetExecutionTargetAck: recordAck,
    sealTenantCredentialTargetExecution: seal,
    getTenantCredentialTargetExecutionJob: vi.fn(async () => null),
    getTenantCredentialTargetExecutionTargets: vi.fn(async () => {
      trace.push("targets");
      return [target];
    }),
    getTenantCredentialTargetExecutionTargetAcks: vi.fn(async () => {
      trace.push("acks");
      return [...acks].map((targetOrdinal) => ({ targetOrdinal }) as never);
    }),
    getTenantCredentialTargetExecutionReceipt: vi.fn(async () => null),
    getTenantCredentialTargetExecutionCutover: vi.fn(async () => ({
      singletonId: 1 as const,
      controlGeneration: 0 as const,
    })),
    hasTenantCredentialTargetExecutionJobs: vi.fn(async () => true),
  };
  const state = createFakeCredentialTargetExecutionAdapterState();
  const fake = new FakeCredentialTargetExecutionAdapter(state);
  const adapter: TenantCredentialTargetExecutionAdapter = options.traceAdapter
    ? {
        adapterProtocol: fake.adapterProtocol,
        domain: fake.domain,
        inspectTarget: async (input) => { trace.push("inspect"); return fake.inspectTarget(input); },
        applyTarget: async (input) => { trace.push("apply"); return fake.applyTarget(input); },
        close: () => fake.close(),
      }
    : fake;
  const canExecute = vi.fn(async () => { trace.push("gate"); return true; });
  return {
    store,
    adapter,
    state,
    target,
    acks,
    trace,
    canExecute,
    materialize,
    claimJobs,
    renew,
    retry,
    block,
    recordAck,
    seal,
  };
}

describe("TenantCredentialTargetExecutionWorker", () => {
  it("uses a fresh gate for every materialize, claim, renew, inspect, apply, ACK, and seal boundary", async () => {
    const state = fixture({ traceAdapter: true });
    const worker = new TenantCredentialTargetExecutionWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: state.canExecute,
    }, { leaseMs: 500, batchSize: 3, materializeBatchSize: 7 });

    await expect(worker.processOnce()).resolves.toBe(1);
    for (const operation of ["materialize", "claim", "renew", "ack", "seal"]) {
      const positions = state.trace
        .map((entry, index) => entry === operation ? index : -1)
        .filter((index) => index >= 0);
      expect(positions.length, operation).toBeGreaterThan(0);
      for (const position of positions) expect(state.trace[position - 1], operation).toBe("gate");
    }
    for (const operation of ["inspect", "apply"]) {
      const positions = state.trace
        .map((entry, index) => entry === operation ? index : -1)
        .filter((index) => index >= 0);
      expect(positions.length, operation).toBeGreaterThan(0);
      for (const position of positions) {
        expect(state.trace[position - 1], operation).toBe("renew");
        expect(state.trace[position - 2], operation).toBe("gate");
      }
    }
    expect(state.materialize).toHaveBeenCalledWith({ limit: 7 });
    expect(state.claimJobs).toHaveBeenCalledWith(expect.objectContaining({
      limit: 3,
      leaseMs: 500,
    }));
    expect(state.retry).not.toHaveBeenCalled();
  });

  it("renews after a slow fresh gate immediately before every provider inspect and apply", async () => {
    const state = fixture({ traceAdapter: true });
    let nowMs = 0;
    let leaseUntilMs = 0;
    state.canExecute.mockImplementation(async () => {
      state.trace.push("gate");
      nowMs += 31_000;
      return true;
    });
    state.renew.mockImplementation(async () => {
      state.trace.push("renew");
      leaseUntilMs = nowMs + 30_000;
      return true;
    });
    const delegate = state.adapter;
    state.adapter = {
      adapterProtocol: delegate.adapterProtocol,
      domain: delegate.domain,
      inspectTarget: async (input) => {
        if (nowMs >= leaseUntilMs) throw new Error("stale inspect claim");
        state.trace.push("inspect");
        return delegate.inspectTarget(input);
      },
      applyTarget: async (input) => {
        if (nowMs >= leaseUntilMs) throw new Error("stale apply claim");
        state.trace.push("apply");
        return delegate.applyTarget(input);
      },
      close: () => delegate.close(),
    };
    const worker = new TenantCredentialTargetExecutionWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: state.canExecute,
    }, { leaseMs: 30_000 });

    await expect(worker.processOnce()).resolves.toBe(1);
    for (const operation of ["inspect", "apply"]) {
      const position = state.trace.indexOf(operation);
      expect(position).toBeGreaterThan(1);
      expect(state.trace.slice(position - 2, position + 1)).toEqual(["gate", "renew", operation]);
    }
  });

  it("recovers apply-committed response loss by a fresh gated inspect, without applying twice", async () => {
    const state = fixture({ traceAdapter: true });
    queueFakeCredentialTargetExecutionFault(state.state, state.target.operationIdSha256, {
      method: "apply",
      kind: "apply_committed_response_lost",
    });
    const apply = vi.spyOn(state.adapter, "applyTarget");
    const inspect = vi.spyOn(state.adapter, "inspectTarget");
    const worker = new TenantCredentialTargetExecutionWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: state.canExecute,
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(apply).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(state.recordAck).toHaveBeenCalledOnce();
    expect(state.retry).not.toHaveBeenCalled();
  });

  it("replays an ACK after the first store call commits and loses its response", async () => {
    const state = fixture({ traceAdapter: true });
    const apply = vi.spyOn(state.adapter, "applyTarget");
    let calls = 0;
    state.recordAck.mockImplementation(async (_authorization, result) => {
      state.trace.push("ack");
      state.acks.add(state.target.targetOrdinal);
      calls += 1;
      if (calls === 1) throw new Error("ACK committed but response was lost");
      expect(result.operationIdSha256).toBe(state.target.operationIdSha256);
      return { targetOrdinal: state.target.targetOrdinal } as never;
    });
    const worker = new TenantCredentialTargetExecutionWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: state.canExecute,
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(apply).toHaveBeenCalledOnce();
    expect(state.recordAck).toHaveBeenCalledTimes(2);
    expect(state.recordAck.mock.calls[1]![0]).toEqual(state.recordAck.mock.calls[0]![0]);
    expect(state.recordAck.mock.calls[1]![1].evidenceSha256)
      .toBe(state.recordAck.mock.calls[0]![1].evidenceSha256);
    expect(state.retry).not.toHaveBeenCalled();
  });

  it("replays the exact terminal seal after commit response loss", async () => {
    const state = fixture();
    const apply = vi.spyOn(state.adapter, "applyTarget");
    let calls = 0;
    state.seal.mockImplementation(async () => {
      state.trace.push("seal");
      calls += 1;
      if (calls === 1) throw new Error("seal committed but response was lost");
      return { receiptSha256: A } as never;
    });
    const worker = new TenantCredentialTargetExecutionWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: state.canExecute,
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(apply).toHaveBeenCalledOnce();
    expect(state.recordAck).toHaveBeenCalledOnce();
    expect(state.seal).toHaveBeenCalledTimes(2);
    expect(state.seal.mock.calls[1]).toEqual(state.seal.mock.calls[0]);
    expect(state.retry).not.toHaveBeenCalled();
  });

  it("retries temporary failures and never logs the raw error or reference", async () => {
    const state = fixture();
    queueFakeCredentialTargetExecutionFault(state.state, state.target.operationIdSha256, {
      method: "apply",
      kind: "temporary_failure",
    });
    const warn = vi.fn();
    const worker = new TenantCredentialTargetExecutionWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: state.canExecute,
      logger: { warn },
    }, { retryBaseMs: 10, retryMaxMs: 100 });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.retry).toHaveBeenCalledWith(expect.objectContaining({ claimAttempt: 2 }), {
      delayMs: 20,
      errorCode: "temporary_failure",
    });
    expect(state.block).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("never-log-or-persist-this-reference");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("temporary unavailable");
  });

  it("blocks permanent failure and operation conflict as integrity conflicts", async () => {
    for (const kind of ["permanent_failure", "operation_conflict"] as const) {
      const state = fixture();
      queueFakeCredentialTargetExecutionFault(state.state, state.target.operationIdSha256, {
        method: "apply",
        kind,
      });
      const worker = new TenantCredentialTargetExecutionWorker({
        store: state.store,
        adapter: state.adapter,
        canExecute: state.canExecute,
      });

      await expect(worker.processOnce()).resolves.toBe(0);
      expect(state.block).toHaveBeenCalledWith(expect.any(Object), "integrity_conflict");
      expect(state.retry).not.toHaveBeenCalled();
    }
  });

  it("stops before a boundary when the fresh gate closes", async () => {
    const state = fixture({ traceAdapter: true });
    const gates = [true, true, true, true, true, true, false];
    const worker = new TenantCredentialTargetExecutionWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: vi.fn(async () => gates.shift() ?? false),
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.trace).not.toContain("apply");
    expect(state.recordAck).not.toHaveBeenCalled();
    expect(state.seal).not.toHaveBeenCalled();
  });

  it("fails closed on invalid worker bounds", () => {
    const state = fixture();
    expect(() => new TenantCredentialTargetExecutionWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: state.canExecute,
    }, { batchSize: 101 })).toThrow(/must not exceed 100/);
    expect(() => new TenantCredentialTargetExecutionWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: state.canExecute,
    }, { retryBaseMs: 10, retryMaxMs: 9 })).toThrow(/must be >=/);
  });
});
