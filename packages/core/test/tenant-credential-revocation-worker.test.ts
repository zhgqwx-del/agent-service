import { describe, expect, it, vi } from "vitest";
import {
  TenantErasureIntegrityError,
  type ClaimTenantCredentialRevocationsOptions,
  type TenantCredentialRevocationClaim,
  type TenantCredentialRevocationReceipt,
  type TenantCredentialRevocationStore,
} from "@agent-service/store";
import { TenantCredentialRevocationWorker } from "../src/index.js";

const REQUEST_ID = "erase_12345678-1234-4123-8123-123456789abc";

function claim(input: ClaimTenantCredentialRevocationsOptions): TenantCredentialRevocationClaim {
  return {
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 1,
    t1FenceSha256: "1".repeat(64),
    phase: "queued",
    claimAttempt: 2,
    claimToken: input.claimToken,
    leaseUntilMs: 100_000,
  };
}

function receipt(completedClaimTokenSha256 = "2".repeat(64)): TenantCredentialRevocationReceipt {
  return {
    scope: "local-db-credential-material-v1",
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 1,
    t1FenceSha256: "1".repeat(64),
    apiKeyCountBefore: 1,
    apiKeyCountAfter: 0,
    providerConfigCountBefore: 1,
    providerConfigCountAfter: 0,
    authPolicyPresentBefore: true,
    authPolicyPresentAfter: false,
    authSecretCipherPresentBefore: true,
    authSecretCipherPresentAfter: false,
    authSecretKeyIdPresentBefore: true,
    authSecretKeyIdPresentAfter: false,
    storeDbTimestampMs: 10,
    completedClaimAttempt: 2,
    completedClaimTokenSha256,
    runtimeDisposition: "not_in_scope",
    externalDisposition: "not_supported",
    contentPurgeRequired: true,
    receiptSha256: "3".repeat(64),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeStore(options: {
  materializeFails?: boolean;
  renews?: boolean;
  revokeError?: Error;
} = {}) {
  const materialize = options.materializeFails
    ? vi.fn(async () => { throw new Error("mysql://credential-bearing-materialize-error"); })
    : vi.fn(async () => 1);
  const claimJobs = vi.fn(async (input: ClaimTenantCredentialRevocationsOptions) => [claim(input)]);
  const renew = vi.fn(async () => options.renews ?? true);
  const retry = vi.fn(async () => true);
  const block = vi.fn(async () => true);
  const revoke = options.revokeError
    ? vi.fn(async () => { throw options.revokeError; })
    : vi.fn(async () => receipt());
  const store: TenantCredentialRevocationStore = {
    materializeTenantCredentialRevocationJobs: materialize,
    claimTenantCredentialRevocations: claimJobs,
    renewTenantCredentialRevocation: renew,
    retryTenantCredentialRevocation: retry,
    blockTenantCredentialRevocation: block,
    revokeTenantCredentialMaterial: revoke,
    getTenantCredentialRevocationJob: vi.fn(async () => null),
    getTenantCredentialRevocationReceipt: vi.fn(async () => null),
    getTenantCredentialRevocationCutover: vi.fn(async () => ({
      singletonId: 1 as const,
      controlGeneration: 0 as const,
    })),
  };
  return { store, materialize, claimJobs, renew, retry, block, revoke };
}

describe("TenantCredentialRevocationWorker", () => {
  it("does no durable work while the execution barrier is false or unavailable", async () => {
    const state = makeStore();
    const canExecute = vi.fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("router unavailable"));
    const worker = new TenantCredentialRevocationWorker({ store: state.store, canExecute });

    await expect(worker.processOnce()).resolves.toBe(0);
    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.materialize).not.toHaveBeenCalled();
    expect(state.claimJobs).not.toHaveBeenCalled();
  });

  it("uses fresh barriers before materialization, claim and each destructive transaction", async () => {
    const calls: string[] = [];
    const state = makeStore();
    state.materialize.mockImplementation(async () => {
      calls.push("materialize");
      return 1;
    });
    state.claimJobs.mockImplementation(async (input) => {
      calls.push("claim");
      return [claim(input)];
    });
    state.renew.mockImplementation(async () => {
      calls.push("renew");
      return true;
    });
    state.revoke.mockImplementation(async () => {
      calls.push("revoke");
      return receipt();
    });
    const worker = new TenantCredentialRevocationWorker({
      store: state.store,
      canExecute: async () => {
        calls.push("barrier");
        return true;
      },
    }, { leaseMs: 500, batchSize: 3, materializeBatchSize: 7 });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(calls).toEqual([
      "barrier",
      "materialize",
      "barrier",
      "claim",
      "renew",
      "barrier",
      "revoke",
    ]);
    expect(state.materialize).toHaveBeenCalledWith({ limit: 7 });
    expect(state.claimJobs).toHaveBeenCalledWith(expect.objectContaining({
      limit: 3,
      leaseMs: 500,
    }));
  });

  it("does not materialize when shutdown wins an in-flight initial barrier", async () => {
    const state = makeStore();
    const pendingBarrier = deferred<boolean>();
    const canExecute = vi.fn(() => pendingBarrier.promise);
    const worker = new TenantCredentialRevocationWorker({ store: state.store, canExecute });

    const run = worker.processOnce();
    await vi.waitFor(() => expect(canExecute).toHaveBeenCalledOnce());
    await worker.stop();
    pendingBarrier.resolve(true);

    await expect(run).resolves.toBe(0);
    expect(state.materialize).not.toHaveBeenCalled();
    expect(state.claimJobs).not.toHaveBeenCalled();
    expect(state.revoke).not.toHaveBeenCalled();
  });

  it("does not claim when shutdown wins an in-flight pre-claim barrier", async () => {
    const state = makeStore();
    const pendingBarrier = deferred<boolean>();
    const canExecute = vi.fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => pendingBarrier.promise);
    const worker = new TenantCredentialRevocationWorker({ store: state.store, canExecute });

    const run = worker.processOnce();
    await vi.waitFor(() => expect(canExecute).toHaveBeenCalledTimes(2));
    expect(state.materialize).toHaveBeenCalledOnce();
    await worker.stop();
    pendingBarrier.resolve(true);

    await expect(run).resolves.toBe(0);
    expect(state.claimJobs).not.toHaveBeenCalled();
    expect(state.revoke).not.toHaveBeenCalled();
  });

  it("does not revoke when shutdown wins the final in-flight barrier", async () => {
    const state = makeStore();
    const pendingBarrier = deferred<boolean>();
    const canExecute = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => pendingBarrier.promise);
    const worker = new TenantCredentialRevocationWorker({ store: state.store, canExecute });

    const run = worker.processOnce();
    await vi.waitFor(() => expect(canExecute).toHaveBeenCalledTimes(3));
    expect(state.renew).toHaveBeenCalledOnce();
    await worker.stop();
    pendingBarrier.resolve(true);

    await expect(run).resolves.toBe(0);
    expect(state.revoke).not.toHaveBeenCalled();
    expect(state.retry).toHaveBeenCalledOnce();
  });

  it("releases a claim when the final fresh barrier closes", async () => {
    const state = makeStore();
    const canExecute = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const worker = new TenantCredentialRevocationWorker({ store: state.store, canExecute }, {
      retryBaseMs: 10,
      retryMaxMs: 100,
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.revoke).not.toHaveBeenCalled();
    expect(state.retry).toHaveBeenCalledWith(expect.objectContaining({
      requestId: REQUEST_ID,
      claimAttempt: 2,
    }), { delayMs: 20, errorCode: "temporary_failure" });
  });

  it("blocks typed proof conflicts and never logs backend details", async () => {
    const state = makeStore({ revokeError: new TenantErasureIntegrityError() });
    const warn = vi.fn();
    const worker = new TenantCredentialRevocationWorker({
      store: state.store,
      canExecute: async () => true,
      logger: { warn },
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.block).toHaveBeenCalledOnce();
    expect(state.retry).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[tenant-credential-revocation-worker] claim failed");
  });

  it("retries unknown failures with DB-relative delay and bounded logs", async () => {
    const state = makeStore({
      revokeError: new Error("mysql://user:secret@host/credential-row"),
    });
    const warn = vi.fn();
    const worker = new TenantCredentialRevocationWorker({
      store: state.store,
      canExecute: async () => true,
      logger: { warn },
    }, { retryBaseMs: 10, retryMaxMs: 100 });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.block).not.toHaveBeenCalled();
    expect(state.retry).toHaveBeenCalledWith(expect.anything(), {
      delayMs: 20,
      errorCode: "temporary_failure",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  });

  it("does not cross a lost lease and still claims queued work after materialization fails", async () => {
    const state = makeStore({ materializeFails: true, renews: false });
    const warn = vi.fn();
    const worker = new TenantCredentialRevocationWorker({
      store: state.store,
      canExecute: async () => true,
      logger: { warn },
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.claimJobs).toHaveBeenCalledOnce();
    expect(state.revoke).not.toHaveBeenCalled();
    expect(state.retry).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[tenant-credential-revocation-worker] materialization failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("credential-bearing");
  });
});
