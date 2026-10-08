import { describe, expect, it, vi } from "vitest";
import type {
  ClaimErasurePolicyEvaluationsOptions,
  ErasurePolicyEvaluationStore,
} from "@agent-service/store";
import { ErasurePurgeEvidenceChangedError } from "@agent-service/store";
import { PurgePolicyEvaluator } from "../src/lifecycle/purge-policy-evaluator.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeStore(options: { buildFails?: boolean; renews?: boolean } = {}) {
  const schedule = vi.fn(async () => 1);
  const claim = vi.fn(async (input: ClaimErasurePolicyEvaluationsOptions) => [{
    requestId: "erase_request-1",
    tenantId: "tenant-a",
    subjectKind: "user" as const,
    subjectId: "user-a",
    subjectGeneration: 1,
    buildGeneration: 1,
    claimToken: input.claimToken,
    claimAttempt: 2,
    availableAtMs: input.nowMs,
    leaseUntilMs: input.nowMs + input.leaseMs,
  }]);
  const renew = vi.fn(async () => options.renews ?? true);
  const build = options.buildFails
    ? vi.fn(async () => { throw new Error("mysql://credential-bearing-error"); })
    : vi.fn()
      .mockResolvedValueOnce({
        built: 1,
        done: false,
        cursorSessionId: "sess_1",
        targetCount: 1,
        targetRootSha256: "1".repeat(64),
      })
      .mockResolvedValueOnce({
        built: 0,
        done: true,
        cursorSessionId: "sess_1",
        targetCount: 1,
        targetRootSha256: "1".repeat(64),
      });
  const seal = vi.fn(async () => undefined as never);
  const retry = vi.fn(async () => true);
  const store: ErasurePolicyEvaluationStore = {
    scheduleAwaitingErasurePolicyEvaluations: schedule,
    claimErasurePolicyEvaluations: claim,
    renewErasurePolicyEvaluation: renew,
    retryErasurePolicyEvaluation: retry,
    buildErasurePurgeTargetPage: build,
    sealErasurePurgeAuthority: seal,
    getErasurePolicyEvaluationJob: vi.fn(async () => null),
    listErasurePurgeTargetEvidence: vi.fn(async () => []),
    listErasurePolicyEvaluationDecisions: vi.fn(async () => []),
    getValidatedErasurePurgeAuthority: vi.fn(async () => null),
    getErasureCompletionReadiness: vi.fn(async (requestId: string) => ({
      requestId,
      complete: false as const,
      missing: ["purge_execution_disabled" as const],
    })),
  };
  return { store, schedule, claim, renew, build, seal, retry };
}

describe("PurgePolicyEvaluator", () => {
  it("does no durable work until the versioned fleet barrier ACKs", async () => {
    const { store, schedule, claim } = makeStore();
    const canClaim = vi.fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("router unavailable"));
    const worker = new PurgePolicyEvaluator({ store, canClaim });

    await expect(worker.processOnce()).resolves.toBe(0);
    await expect(worker.processOnce()).resolves.toBe(0);
    expect(canClaim).toHaveBeenCalledTimes(2);
    expect(schedule).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("builds bounded pages under a renewed lease and seals evidence only", async () => {
    const calls: string[] = [];
    const state = makeStore();
    state.schedule.mockImplementation(async () => {
      calls.push("schedule");
      return 1;
    });
    state.claim.mockImplementation(async (input) => {
      calls.push("claim");
      return [{
        requestId: "erase_request-1",
        tenantId: "tenant-a",
        subjectKind: "user",
        subjectId: "user-a",
        subjectGeneration: 1,
        buildGeneration: 1,
        claimToken: input.claimToken,
        claimAttempt: 2,
        availableAtMs: input.nowMs,
        leaseUntilMs: input.nowMs + input.leaseMs,
      }];
    });
    const worker = new PurgePolicyEvaluator({
      store: state.store,
      canClaim: async () => {
        calls.push("barrier");
        return true;
      },
      clock: { now: () => 1_000 },
    }, {
      leaseMs: 500,
      jobBatchSize: 3,
      targetPageSize: 7,
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(calls.slice(0, 3)).toEqual(["barrier", "schedule", "claim"]);
    expect(state.claim).toHaveBeenCalledWith(expect.objectContaining({
      nowMs: 1_000,
      limit: 3,
      leaseMs: 500,
    }));
    expect(state.renew).toHaveBeenCalledTimes(3);
    expect(state.build).toHaveBeenCalledTimes(2);
    expect(state.build).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "erase_request-1",
      claimAttempt: 2,
    }), { nowMs: 1_000, limit: 7 });
    expect(state.seal).toHaveBeenCalledOnce();
    expect(state.retry).not.toHaveBeenCalled();
  });

  it("continues claiming durable work when scheduling fails without logging error details", async () => {
    const state = makeStore();
    state.schedule.mockRejectedValue(new Error("mysql://credential-bearing-scheduler-error"));
    const warn = vi.fn();
    const worker = new PurgePolicyEvaluator({
      store: state.store,
      canClaim: async () => true,
      clock: { now: () => 1_000 },
      logger: { warn },
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.claim).toHaveBeenCalledOnce();
    expect(state.seal).toHaveBeenCalledOnce();
    expect(state.retry).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("[purge-policy-evaluator] scheduling failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("credential-bearing-scheduler-error");
  });

  it("does not build or seal after losing its claim lease", async () => {
    const state = makeStore({ renews: false });
    const worker = new PurgePolicyEvaluator({
      store: state.store,
      canClaim: async () => true,
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.build).not.toHaveBeenCalled();
    expect(state.seal).not.toHaveBeenCalled();
    expect(state.retry).not.toHaveBeenCalled();
  });

  it("persists a bounded retry without logging backend details", async () => {
    const state = makeStore({ buildFails: true });
    const warn = vi.fn();
    const worker = new PurgePolicyEvaluator({
      store: state.store,
      canClaim: async () => true,
      clock: { now: () => 2_000 },
      logger: { warn },
    }, {
      retryBaseMs: 10,
      retryMaxMs: 100,
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.seal).not.toHaveBeenCalled();
    expect(state.retry).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "erase_request-1",
      claimAttempt: 2,
    }), {
      failedAtMs: 2_000,
      availableAtMs: 2_020,
      errorCode: "temporary_failure",
    });
    expect(warn).toHaveBeenCalledWith("[purge-policy-evaluator] claim failed");
  });

  it("rebuilds a stale evidence generation but keeps unknown failures temporary", async () => {
    const changed = makeStore();
    changed.build.mockReset();
    changed.build.mockResolvedValue({
      built: 0,
      done: true,
      targetCount: 0,
      targetRootSha256: "1".repeat(64),
    });
    changed.seal.mockRejectedValue(new ErasurePurgeEvidenceChangedError());
    const changedWorker = new PurgePolicyEvaluator({
      store: changed.store,
      canClaim: async () => true,
      clock: { now: () => 2_000 },
      logger: { warn: vi.fn() },
    }, { retryBaseMs: 10, retryMaxMs: 100 });

    await expect(changedWorker.processOnce()).resolves.toBe(0);
    expect(changed.retry).toHaveBeenCalledWith(expect.objectContaining({
      buildGeneration: 1,
      claimAttempt: 2,
    }), {
      failedAtMs: 2_000,
      availableAtMs: 2_020,
      errorCode: "evidence_changed",
    });

    const unknown = makeStore();
    unknown.build.mockReset();
    unknown.build.mockResolvedValue({
      built: 0,
      done: true,
      targetCount: 0,
      targetRootSha256: "1".repeat(64),
    });
    unknown.seal.mockRejectedValue(new Error("unclassified backend failure"));
    const unknownWorker = new PurgePolicyEvaluator({
      store: unknown.store,
      canClaim: async () => true,
      clock: { now: () => 2_000 },
      logger: { warn: vi.fn() },
    }, { retryBaseMs: 10, retryMaxMs: 100 });

    await expect(unknownWorker.processOnce()).resolves.toBe(0);
    expect(unknown.retry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      errorCode: "temporary_failure",
    }));
  });

  it("stops after the current atomic page, releases the claim, and never seals partial evidence", async () => {
    vi.useFakeTimers();
    const state = makeStore();
    const page = deferred<Awaited<ReturnType<ErasurePolicyEvaluationStore["buildErasurePurgeTargetPage"]>>>();
    state.build.mockReset();
    state.build.mockImplementation(async () => page.promise);
    const worker = new PurgePolicyEvaluator({
      store: state.store,
      canClaim: async () => true,
      clock: { now: () => 1_000 },
    }, {
      pollIntervalMs: 10,
      retryBaseMs: 5,
      retryMaxMs: 20,
    });

    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(state.build).toHaveBeenCalledOnce());

      const stopped = worker.stop();
      page.resolve({
        built: 1,
        done: false,
        cursorSessionId: "sess_1",
        targetCount: 1,
        targetRootSha256: "1".repeat(64),
      });
      await expect(stopped).resolves.toBeUndefined();

      expect(state.build).toHaveBeenCalledOnce();
      expect(state.retry).toHaveBeenCalledOnce();
      expect(state.retry).toHaveBeenCalledWith(expect.objectContaining({
        requestId: "erase_request-1",
        claimAttempt: 2,
      }), {
        failedAtMs: 1_000,
        availableAtMs: 1_010,
        errorCode: "temporary_failure",
      });
      expect(state.seal).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      expect(state.claim).toHaveBeenCalledOnce();
      expect(state.build).toHaveBeenCalledOnce();
    } finally {
      await worker.stop();
      vi.useRealTimers();
    }
  });

  it("keeps shutdown fail-closed when durable retry fails and does not restart its timer", async () => {
    vi.useFakeTimers();
    const state = makeStore();
    const page = deferred<Awaited<ReturnType<ErasurePolicyEvaluationStore["buildErasurePurgeTargetPage"]>>>();
    state.build.mockReset();
    state.build.mockImplementation(async () => page.promise);
    state.retry.mockRejectedValue(new Error("credential-bearing retry failure"));
    const warn = vi.fn();
    const worker = new PurgePolicyEvaluator({
      store: state.store,
      canClaim: async () => true,
      clock: { now: () => 1_000 },
      logger: { warn },
    }, { pollIntervalMs: 10 });

    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(state.build).toHaveBeenCalledOnce());

      const stopped = worker.stop();
      page.resolve({
        built: 1,
        done: false,
        cursorSessionId: "sess_1",
        targetCount: 1,
        targetRootSha256: "1".repeat(64),
      });
      await expect(stopped).resolves.toBeUndefined();

      // The shutdown release and the ordinary catch-path retry may both fail. In either case the
      // fenced lease is left to expire; no seal or another timer-driven claim is allowed.
      expect(state.retry).toHaveBeenCalledTimes(2);
      expect(state.seal).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("[purge-policy-evaluator] claim failed");
      expect(warn).toHaveBeenCalledWith("[purge-policy-evaluator] polling failed");

      await vi.advanceTimersByTimeAsync(100);
      expect(state.claim).toHaveBeenCalledOnce();
      expect(state.build).toHaveBeenCalledOnce();
    } finally {
      await worker.stop();
      vi.useRealTimers();
    }
  });

  it("validates worker bounds", () => {
    const { store } = makeStore();
    expect(() => new PurgePolicyEvaluator({
      store,
      canClaim: async () => true,
    }, { jobBatchSize: 101 })).toThrow(/jobBatchSize/);
    expect(() => new PurgePolicyEvaluator({
      store,
      canClaim: async () => true,
    }, { targetPageSize: 1_001 })).toThrow(/targetPageSize/);
    expect(() => new PurgePolicyEvaluator({
      store,
      canClaim: async () => true,
    }, { retryBaseMs: 2, retryMaxMs: 1 })).toThrow(/retryMaxMs/);
  });
});
