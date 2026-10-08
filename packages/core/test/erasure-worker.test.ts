import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyUsage, type Session } from "@agent-service/protocol";
import {
  ErasureTombstoneIntegrityError,
  MemorySessionStore,
  UsageIdentityConflictError,
  UsageLifecycleGenerationError,
  UsageReconciliationError,
  newErasureRequestId,
  userErasureRequestHash,
} from "@agent-service/store";
import type {
  ClaimErasureJobsOptions,
  ErasureJobAuthorization,
  ErasureJobClaim,
  ErasureJobStore,
  ErasureProgressQuery,
  ErasureSessionCatalogStore,
  ErasureSessionPage,
  ErasureSessionQuery,
  ErasureSubjectProgress,
  ErasureUsageReconciliationInput,
  ErasureWriteAuthorization,
  RenewErasureJobClaimOptions,
  RetryErasureJobOptions,
  TransitionErasureJobOptions,
  UsageReconciliationRecord,
} from "@agent-service/store";
import {
  ErasureSessionExecutionError,
  ErasureWorker,
  newId,
  type ErasureSessionExecutor,
} from "../src/index.js";

const SESSION_1 = "sess_00000000-0000-4000-8000-000000000001";
const SESSION_2 = "sess_00000000-0000-4000-8000-000000000002";
const SESSION_3 = "sess_00000000-0000-4000-8000-000000000003";

function claim(
  status: ErasureJobClaim["status"],
  overrides: Partial<ErasureJobClaim> = {},
): ErasureJobClaim {
  return {
    requestId: "erase_00000000-0000-4000-8000-000000000001",
    tenantId: "tenant-a",
    subjectKind: "user",
    subjectId: "user-a",
    subjectGeneration: 1,
    status,
    availableAtMs: 1_000,
    attempts: 1,
    claimToken: "claim-1",
    leaseUntilMs: 31_000,
    ...overrides,
  };
}

function jobAuthorization(claim: ErasureJobClaim): ErasureJobAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectKind: claim.subjectKind,
    subjectId: claim.subjectId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

function progress(overrides: Partial<ErasureSubjectProgress> = {}): ErasureSubjectProgress {
  return {
    totalSessions: 0,
    liveSessions: 0,
    liveLeafSessions: 0,
    tombstonedSessions: 0,
    legacyGenerationZeroSessions: 0,
    reconciledUsageSessions: 0,
    unreconciledUsageSessions: 0,
    orphanOrMismatchedUsageRows: 0,
    ...overrides,
  };
}

class FakeJobs implements ErasureJobStore {
  claimBatches: ErasureJobClaim[][] = [];
  claimCalls: ClaimErasureJobsOptions[] = [];
  renewCalls: Array<{ authorization: ErasureJobAuthorization; options: RenewErasureJobClaimOptions }> = [];
  transitionCalls: Array<{ authorization: ErasureJobAuthorization; options: TransitionErasureJobOptions }> = [];
  retryCalls: Array<{ authorization: ErasureJobAuthorization; options: RetryErasureJobOptions }> = [];
  claimHook?: (options: ClaimErasureJobsOptions) => Promise<ErasureJobClaim[]> | ErasureJobClaim[];
  renewHook: () => Promise<boolean> | boolean = () => true;
  transitionHook: (
    authorization: ErasureJobAuthorization,
    options: TransitionErasureJobOptions,
  ) => Promise<boolean> | boolean = () => true;
  retryHook: (
    authorization: ErasureJobAuthorization,
    options: RetryErasureJobOptions,
  ) => Promise<boolean> | boolean = () => true;

  async claimErasureJobs(options: ClaimErasureJobsOptions): Promise<ErasureJobClaim[]> {
    this.claimCalls.push(structuredClone(options));
    if (this.claimHook) return structuredClone(await this.claimHook(options));
    return structuredClone(this.claimBatches.shift() ?? []);
  }

  async renewErasureJobClaim(
    authorization: ErasureJobAuthorization,
    options: RenewErasureJobClaimOptions,
  ): Promise<boolean> {
    this.renewCalls.push({ authorization: structuredClone(authorization), options: structuredClone(options) });
    return await this.renewHook();
  }

  async transitionErasureJob(
    authorization: ErasureJobAuthorization,
    options: TransitionErasureJobOptions,
  ): Promise<boolean> {
    this.transitionCalls.push({ authorization: structuredClone(authorization), options: structuredClone(options) });
    return await this.transitionHook(authorization, options);
  }

  async retryErasureJob(
    authorization: ErasureJobAuthorization,
    options: RetryErasureJobOptions,
  ): Promise<boolean> {
    this.retryCalls.push({ authorization: structuredClone(authorization), options: structuredClone(options) });
    return await this.retryHook(authorization, options);
  }
}

class FakeCatalog implements ErasureSessionCatalogStore {
  listCalls: Array<{ authority: ErasureWriteAuthorization; query: ErasureSessionQuery }> = [];
  progressCalls: Array<{ authority: ErasureWriteAuthorization; query: ErasureProgressQuery }> = [];
  listHook: (
    authority: ErasureWriteAuthorization,
    query: ErasureSessionQuery,
  ) => Promise<ErasureSessionPage> | ErasureSessionPage = () => ({ data: [] });
  progressHook: (
    authority: ErasureWriteAuthorization,
    query: ErasureProgressQuery,
  ) => Promise<ErasureSubjectProgress> | ErasureSubjectProgress = () => progress();

  async listErasureSessions(
    authority: ErasureWriteAuthorization,
    query: ErasureSessionQuery,
  ): Promise<ErasureSessionPage> {
    this.listCalls.push({ authority: structuredClone(authority), query: structuredClone(query) });
    return structuredClone(await this.listHook(authority, query));
  }

  async inspectErasureSubjectProgress(
    authority: ErasureWriteAuthorization,
    query: ErasureProgressQuery,
  ): Promise<ErasureSubjectProgress> {
    this.progressCalls.push({ authority: structuredClone(authority), query: structuredClone(query) });
    return structuredClone(await this.progressHook(authority, query));
  }
}

class FakeUsage {
  calls: Array<{
    authority: ErasureWriteAuthorization;
    input: ErasureUsageReconciliationInput;
  }> = [];
  hook?: (
    authority: ErasureWriteAuthorization,
    input: ErasureUsageReconciliationInput,
  ) => Promise<UsageReconciliationRecord> | UsageReconciliationRecord;

  async reconcileErasureSessionUsage(
    authority: ErasureWriteAuthorization,
    input: ErasureUsageReconciliationInput,
  ): Promise<UsageReconciliationRecord> {
    this.calls.push(structuredClone({ authority, input }));
    if (this.hook) return await this.hook(authority, input);
    return {
      tenantId: authority.tenantId,
      userId: authority.userId,
      ...input,
      status: "verified",
      verifiedAtMs: input.nowMs,
      rowCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      knownCostRows: 0,
      checksum: "0".repeat(64),
    };
  }
}

class FakeExecutor implements ErasureSessionExecutor {
  drains: string[] = [];
  erases: string[] = [];
  drainHook?: (sessionId: string) => Promise<void> | void;
  eraseHook?: (sessionId: string) => Promise<void> | void;

  async drainSessionForErasure(_authority: ErasureWriteAuthorization, sessionId: string): Promise<void> {
    this.drains.push(sessionId);
    await this.drainHook?.(sessionId);
  }

  async eraseSessionForErasure(_authority: ErasureWriteAuthorization, sessionId: string): Promise<void> {
    this.erases.push(sessionId);
    await this.eraseHook?.(sessionId);
  }
}

function setup(status: ErasureJobClaim["status"], options: ConstructorParameters<typeof ErasureWorker>[1] = {}) {
  const jobs = new FakeJobs();
  const catalog = new FakeCatalog();
  const usage = new FakeUsage();
  const executor = new FakeExecutor();
  jobs.claimBatches.push([claim(status)]);
  const worker = new ErasureWorker(
    { jobs, catalog, usage, executor, clock: { now: () => 1_000 } },
    options,
  );
  return { worker, jobs, catalog, usage, executor };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
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

async function memoryReconciliationFixture(): Promise<{
  store: MemorySessionStore;
  session: Session;
  requestId: string;
  nowMs: number;
}> {
  const nowMs = Date.now() + 100;
  const store = new MemorySessionStore();
  const session: Session = {
    id: newId("sess"),
    tenantId: "tenant-memory-proof",
    userId: "user-memory-proof",
    agentId: newId("agt"),
    agentVersion: 1,
    status: { type: "idle" },
    lastSeq: 0,
    contextEpoch: "e0",
    fenceToken: 0,
    usage: emptyUsage(),
    autoApprovedTools: [],
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    metadata: {},
  };
  await store.createSession(session);
  await store.commit({
    sessionId: session.id,
    fence: 1,
    lifecycle: {
      type: "tombstone",
      tenantId: session.tenantId,
      userId: session.userId,
      deletionGeneration: 1,
      atMs: nowMs + 1,
    },
    events: [{
      type: "session/deleted",
      sessionId: session.id,
      deletionGeneration: 1,
      emittedAtMs: nowMs + 1,
    }],
  });

  const requestId = newErasureRequestId();
  await store.requestUserErasure({
    requestId,
    tenantId: session.tenantId,
    userId: session.userId,
    requestedByKeyId: "memory-proof",
    idempotencyKey: requestId,
    requestHash: userErasureRequestHash(session.tenantId, session.userId),
    atMs: nowMs + 2,
  });
  let current = (await store.claimErasureJobs({
    nowMs: nowMs + 2,
    limit: 1,
    leaseMs: 30_000,
    claimToken: "memory-proof-gated",
  }))[0]!;
  for (const toStatus of ["draining", "tombstoning", "reconciling_usage"] as const) {
    expect(await store.transitionErasureJob(jobAuthorization(current), {
      fromStatus: current.status,
      toStatus,
      atMs: nowMs + 2,
      availableAtMs: nowMs + 2,
    })).toBe(true);
    current = (await store.claimErasureJobs({
      nowMs: nowMs + 2,
      limit: 1,
      leaseMs: 30_000,
      claimToken: `memory-proof-${toStatus}`,
    }))[0]!;
  }
  const currentWriteAuthority: ErasureWriteAuthorization = {
    requestId: current.requestId,
    tenantId: current.tenantId,
    userId: current.subjectId,
    subjectGeneration: current.subjectGeneration,
    claimToken: current.claimToken,
    claimAttempt: current.attempts,
  };
  expect((await store.listErasureSessions(currentWriteAuthority, {
    phase: "reconciling_usage",
    nowMs: nowMs + 2,
    limit: 10,
  })).data).toEqual([expect.objectContaining({
    sessionId: session.id,
    tombstoneProofValid: true,
  })]);
  // Release the fixture's reconciling claim so the worker must acquire its own attempt/token.
  expect(await store.retryErasureJob(jobAuthorization(current), {
    failedAtMs: nowMs + 2,
    availableAtMs: nowMs + 2,
    errorCode: "temporary_failure",
  })).toBe(true);
  return { store, session, requestId, nowMs: nowMs + 2 };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ErasureWorker phase boundaries", () => {
  it("moves a gated user to draining and does not execute the newly entered phase", async () => {
    const h = setup("gated");

    await expect(h.worker.processOnce()).resolves.toBe(1);

    expect(h.jobs.transitionCalls).toHaveLength(1);
    expect(h.jobs.transitionCalls[0]?.options).toEqual({
      fromStatus: "gated",
      toStatus: "draining",
      atMs: 1_000,
      availableAtMs: 1_000,
    });
    expect(h.catalog.listCalls).toEqual([]);
    expect(h.executor.drains).toEqual([]);
  });

  it("drains live sessions in ascending pages, skips tombstones, then enters tombstoning", async () => {
    const h = setup("draining", { sessionPageSize: 2 });
    h.catalog.listHook = (_authority, query) => query.afterSessionId === undefined
      ? {
          data: [
            { sessionId: SESSION_1, deleted: false, deletionGeneration: 0 },
            { sessionId: SESSION_2, deleted: true, deletionGeneration: 1 },
          ],
          nextCursor: SESSION_2,
        }
      : { data: [{ sessionId: SESSION_3, deleted: false, deletionGeneration: 0 }] };

    await expect(h.worker.processOnce()).resolves.toBe(1);

    expect(h.catalog.listCalls.map(({ query }) => query.afterSessionId)).toEqual([undefined, SESSION_2]);
    expect(h.executor.drains).toEqual([SESSION_1, SESSION_3]);
    expect(h.jobs.transitionCalls[0]?.options).toMatchObject({
      fromStatus: "draining",
      toStatus: "tombstoning",
    });
  });

  it("restarts a draining scan from the beginning after a retryable crash boundary", async () => {
    const h = setup("draining");
    h.jobs.claimBatches.push([claim("draining", { attempts: 2, claimToken: "claim-2" })]);
    h.catalog.listHook = () => ({
      data: [
        { sessionId: SESSION_1, deleted: false, deletionGeneration: 0 },
        { sessionId: SESSION_2, deleted: false, deletionGeneration: 0 },
      ],
    });
    let failed = false;
    h.executor.drainHook = (sessionId) => {
      if (sessionId === SESSION_2 && !failed) {
        failed = true;
        throw new ErasureSessionExecutionError("owner_unavailable");
      }
    };

    await expect(h.worker.processOnce()).resolves.toBe(1);
    await expect(h.worker.processOnce()).resolves.toBe(1);

    expect(h.executor.drains).toEqual([SESSION_1, SESSION_2, SESSION_1, SESSION_2]);
    expect(h.catalog.listCalls.map(({ query }) => query.afterSessionId)).toEqual([undefined, undefined]);
    expect(h.jobs.retryCalls[0]?.options.errorCode).toBe("owner_unavailable");
    expect(h.jobs.transitionCalls.at(-1)?.options.toStatus).toBe("tombstoning");
  });

  it("tombstones live leaves child-first by repeatedly querying the first page", async () => {
    const h = setup("tombstoning", { sessionPageSize: 1 });
    const remaining = [SESSION_2, SESSION_1];
    h.catalog.listHook = () => remaining.length === 0
      ? { data: [] }
      : {
          data: [{ sessionId: remaining[0]!, deleted: false, deletionGeneration: 0 }],
          nextCursor: remaining[0],
        };
    h.catalog.progressHook = () => progress({ totalSessions: 2, tombstonedSessions: 2 });
    h.executor.eraseHook = (sessionId) => {
      expect(sessionId).toBe(remaining.shift());
    };

    await expect(h.worker.processOnce()).resolves.toBe(1);

    expect(h.executor.erases).toEqual([SESSION_2, SESSION_1]);
    expect(h.catalog.listCalls).toHaveLength(3);
    expect(h.catalog.listCalls.every(({ query }) => query.afterSessionId === undefined)).toBe(true);
    expect(h.jobs.transitionCalls.at(-1)?.options).toMatchObject({
      fromStatus: "tombstoning",
      toStatus: "reconciling_usage",
    });
  });

  it("blocks an empty leaf frontier while live sessions remain", async () => {
    const h = setup("tombstoning");
    h.catalog.progressHook = () => progress({ totalSessions: 2, liveSessions: 2, liveLeafSessions: 0 });

    await expect(h.worker.processOnce()).resolves.toBe(1);

    expect(h.executor.erases).toEqual([]);
    expect(h.jobs.transitionCalls[0]?.options).toMatchObject({
      fromStatus: "tombstoning",
      toStatus: "blocked",
      errorCode: "integrity_conflict",
    });
  });

  it("reconciles every tombstone and stops at awaiting_purge_policy", async () => {
    const h = setup("reconciling_usage", { sessionPageSize: 1 });
    h.catalog.listHook = (_authority, query) => query.afterSessionId === undefined
      ? {
          data: [{
            sessionId: SESSION_1,
            deleted: true,
            deletionGeneration: 2,
            tombstoneProofValid: true,
          }],
          nextCursor: SESSION_1,
        }
      : {
          data: [{
            sessionId: SESSION_2,
            deleted: true,
            deletionGeneration: 3,
            tombstoneProofValid: true,
          }],
        };
    h.catalog.progressHook = () => progress({
      totalSessions: 2,
      tombstonedSessions: 2,
      reconciledUsageSessions: 2,
    });

    await expect(h.worker.processOnce()).resolves.toBe(1);

    expect(h.usage.calls.map(({ authority, input }) => ({
      userId: authority.userId,
      sessionId: input.sessionId,
      deletionGeneration: input.deletionGeneration,
    }))).toEqual([
      { userId: "user-a", sessionId: SESSION_1, deletionGeneration: 2 },
      { userId: "user-a", sessionId: SESSION_2, deletionGeneration: 3 },
    ]);
    expect(h.jobs.transitionCalls[0]?.options).toEqual({
      fromStatus: "reconciling_usage",
      toStatus: "awaiting_purge_policy",
      atMs: 1_000,
    });
  });

  it("blocks legacy generation zero before reconciling any usage", async () => {
    const h = setup("reconciling_usage");
    h.catalog.listHook = () => ({
      data: [{ sessionId: SESSION_1, deleted: true, deletionGeneration: 0 }],
    });

    await expect(h.worker.processOnce()).resolves.toBe(1);

    expect(h.usage.calls).toEqual([]);
    expect(h.jobs.transitionCalls[0]?.options).toMatchObject({
      toStatus: "blocked",
      errorCode: "legacy_blocked",
    });
  });

  it.each([undefined, false] as const)(
    "blocks a missing/invalid claim-bound tombstone proof (%s) before usage reconciliation",
    async (tombstoneProofValid) => {
      const h = setup("reconciling_usage");
      h.catalog.listHook = () => ({
        data: [{
          sessionId: SESSION_1,
          deleted: true,
          deletionGeneration: 1,
          ...(tombstoneProofValid === undefined ? {} : { tombstoneProofValid }),
        }],
      });

      await expect(h.worker.processOnce()).resolves.toBe(1);

      expect(h.usage.calls).toEqual([]);
      expect(h.jobs.retryCalls).toEqual([]);
      expect(h.jobs.transitionCalls[0]?.options).toMatchObject({
        fromStatus: "reconciling_usage",
        toStatus: "blocked",
        errorCode: "integrity_conflict",
      });
    },
  );

  it("retries a catalog transport failure instead of misclassifying it as proof corruption", async () => {
    const h = setup("reconciling_usage");
    h.catalog.listHook = () => { throw new Error("database transport unavailable"); };

    await expect(h.worker.processOnce()).resolves.toBe(1);

    expect(h.jobs.transitionCalls).toEqual([]);
    expect(h.jobs.retryCalls[0]?.options).toMatchObject({ errorCode: "temporary_failure" });
    expect(h.usage.calls).toEqual([]);
  });

  it.each([
    ["tombstone proof", new ErasureTombstoneIntegrityError()],
    ["usage identity", new UsageIdentityConflictError("usg_conflicting")],
    ["lifecycle generation", new UsageLifecycleGenerationError(SESSION_1, 1)],
    ["usage reconciliation", new UsageReconciliationError("private integrity detail")],
  ] as const)("durably blocks a deterministic %s failure from claim-bound usage reconciliation", async (_name, error) => {
    const h = setup("reconciling_usage");
    h.catalog.listHook = () => ({
      data: [{
        sessionId: SESSION_1,
        deleted: true,
        deletionGeneration: 1,
        tombstoneProofValid: true,
      }],
    });
    h.usage.hook = () => { throw error; };

    await expect(h.worker.processOnce()).resolves.toBe(1);

    expect(h.usage.calls).toHaveLength(1);
    expect(h.jobs.retryCalls).toEqual([]);
    expect(h.jobs.transitionCalls[0]?.options).toMatchObject({
      fromStatus: "reconciling_usage",
      toStatus: "blocked",
      errorCode: "integrity_conflict",
    });
    expect(JSON.stringify(h.jobs.transitionCalls)).not.toContain(error.message);
  });

  it("retries an unknown usage database failure without persisting its detail", async () => {
    const h = setup("reconciling_usage", { retryBaseMs: 10 });
    h.catalog.listHook = () => ({
      data: [{
        sessionId: SESSION_1,
        deleted: true,
        deletionGeneration: 1,
        tombstoneProofValid: true,
      }],
    });
    h.usage.hook = () => { throw new Error("private database endpoint reset"); };

    await expect(h.worker.processOnce()).resolves.toBe(1);

    expect(h.jobs.transitionCalls).toEqual([]);
    expect(h.jobs.retryCalls[0]?.options).toEqual({
      failedAtMs: 1_000,
      availableAtMs: 1_010,
      errorCode: "temporary_failure",
    });
    expect(JSON.stringify(h.jobs.retryCalls)).not.toContain("private database endpoint");
  });

  it.each([
    [{ liveSessions: 1 }, "integrity_conflict"],
    [{ legacyGenerationZeroSessions: 1 }, "legacy_blocked"],
    [{ orphanOrMismatchedUsageRows: 1 }, "integrity_conflict"],
    [{ unreconciledUsageSessions: 1 }, "integrity_conflict"],
  ] as const)("rejects an incomplete final reconciliation proof %o", async (incomplete, errorCode) => {
    const h = setup("reconciling_usage");
    h.catalog.progressHook = () => progress(incomplete);

    await expect(h.worker.processOnce()).resolves.toBe(1);

    expect(h.jobs.transitionCalls[0]?.options).toMatchObject({
      fromStatus: "reconciling_usage",
      toStatus: "blocked",
      errorCode,
    });
  });

  it("fails a prematurely activated purge closed without touching session or usage data", async () => {
    const h = setup("purging");

    await expect(h.worker.processOnce()).resolves.toBe(1);

    expect(h.jobs.transitionCalls[0]?.options).toMatchObject({
      fromStatus: "purging",
      toStatus: "blocked",
      errorCode: "policy_unavailable",
    });
    expect(h.catalog.listCalls).toEqual([]);
    expect(h.usage.calls).toEqual([]);
    expect(h.executor.drains).toEqual([]);
    expect(h.executor.erases).toEqual([]);
  });
});

describe("ErasureWorker durable Memory tombstone proof gate", () => {
  it("accepts a complete proof after session.tombstoned delivery and reaches the policy boundary", async () => {
    const h = await memoryReconciliationFixture();
    const delivered = await h.store.claimLifecycleOutbox({
      topics: ["session.tombstoned"],
      nowMs: h.nowMs + 1,
      limit: 1,
      leaseMs: 10_000,
      claimToken: "memory-proof-outbox",
    });
    expect(delivered).toHaveLength(1);
    expect(await h.store.completeLifecycleOutbox(
      delivered[0]!.outboxId,
      "memory-proof-outbox",
      h.nowMs + 1,
    )).toBe(true);
    const worker = new ErasureWorker({
      jobs: h.store,
      catalog: h.store,
      usage: h.store,
      executor: new FakeExecutor(),
      clock: { now: () => h.nowMs + 2 },
    });

    await expect(worker.processOnce()).resolves.toBe(1);

    await expect(h.store.getUserErasureRequest(
      h.session.tenantId,
      h.session.userId,
      h.requestId,
    )).resolves.toMatchObject({ status: "awaiting_purge_policy" });
    expect(h.store.usageReconciliations.size).toBe(1);
  });

  it("blocks when proof is damaged after catalog enumeration and before the atomic usage boundary", async () => {
    const h = await memoryReconciliationFixture();
    h.store.usageLedger.push({
      tenantId: h.session.tenantId,
      userId: h.session.userId,
      sessionId: h.session.id,
      turnId: newId("turn"),
      step: 1,
      provider: "legacy",
      model: "legacy",
      usage: { ...emptyUsage(), inputTokens: 1, totalTokens: 1 },
      createdAtMs: h.nowMs,
    });
    let damaged = false;
    const catalog: ErasureSessionCatalogStore = {
      listErasureSessions: async (authority, query) => {
        const page = await h.store.listErasureSessions(authority, query);
        if (query.phase === "reconciling_usage" && !damaged && page.data.length > 0) {
          const purge = [...h.store.lifecycleOutbox.values()].find((row) => (
            row.topic === "session.purge" && row.aggregateId === h.session.id
          ));
          if (!purge) throw new Error("missing purge proof fixture");
          purge.attempts = 1;
          damaged = true;
        }
        return page;
      },
      inspectErasureSubjectProgress: (authority, query) => (
        h.store.inspectErasureSubjectProgress(authority, query)
      ),
    };
    const worker = new ErasureWorker({
      jobs: h.store,
      catalog,
      usage: h.store,
      executor: new FakeExecutor(),
      clock: { now: () => h.nowMs + 2 },
    });

    await expect(worker.processOnce()).resolves.toBe(1);

    await expect(h.store.getUserErasureRequest(
      h.session.tenantId,
      h.session.userId,
      h.requestId,
    )).resolves.toMatchObject({
      status: "blocked",
      lastErrorCode: "integrity_conflict",
    });
    expect(h.store.usageLedger[0]).not.toHaveProperty("usageId");
    expect(h.store.billingUsageFacts.size).toBe(0);
    expect(h.store.usageReconciliations.size).toBe(0);
  });

  it.each([
    ["marker", (store: MemorySessionStore, session: Session) => {
      store.deleted.get(session.id)!.deletedAtMs += 1;
    }],
    ["terminal event", (store: MemorySessionStore, session: Session) => {
      const event = store.events.get(session.id)!.at(-1)!;
      if (event.type !== "session/deleted") throw new Error("invalid fixture event");
      event.deletionGeneration += 1;
    }],
    ["session.tombstoned intent", (store: MemorySessionStore, session: Session) => {
      const row = [...store.lifecycleOutbox.values()].find((candidate) => (
        candidate.topic === "session.tombstoned" && candidate.aggregateId === session.id
      ));
      if (!row || row.topic !== "session.tombstoned") throw new Error("missing fixture outbox");
      row.payload.eventSeq += 1;
    }],
    ["session.purge intent", (store: MemorySessionStore, session: Session) => {
      const row = [...store.lifecycleOutbox.values()].find((candidate) => (
        candidate.topic === "session.purge" && candidate.aggregateId === session.id
      ));
      if (!row) throw new Error("missing fixture outbox");
      row.attempts = 1;
    }],
  ] as const)("durably blocks %s corruption before usage or the policy boundary", async (_name, corrupt) => {
    const h = await memoryReconciliationFixture();
    corrupt(h.store, h.session);
    const worker = new ErasureWorker({
      jobs: h.store,
      catalog: h.store,
      usage: h.store,
      executor: new FakeExecutor(),
      clock: { now: () => h.nowMs + 2 },
    });

    await expect(worker.processOnce()).resolves.toBe(1);

    await expect(h.store.getUserErasureRequest(
      h.session.tenantId,
      h.session.userId,
      h.requestId,
    )).resolves.toMatchObject({
      status: "blocked",
      lastErrorCode: "integrity_conflict",
    });
    expect(h.store.usageReconciliations.size).toBe(0);
  });
});

describe("ErasureWorker authority and retry safety", () => {
  it("starts every claim concurrently so a slow first job cannot age later leases", async () => {
    const jobs = new FakeJobs();
    const catalog = new FakeCatalog();
    const usage = new FakeUsage();
    const executor = new FakeExecutor();
    const secondRequestId = "erase_00000000-0000-4000-8000-000000000002";
    jobs.claimBatches.push([
      claim("draining"),
      claim("draining", {
        requestId: secondRequestId,
        subjectId: "user-b",
        claimToken: "claim-2",
      }),
    ]);
    catalog.listHook = (authority) => ({
      data: [{
        sessionId: authority.userId === "user-a" ? SESSION_1 : SESSION_2,
        deleted: false,
        deletionGeneration: 0,
      }],
    });
    const slowFirst = deferred<void>();
    executor.drainHook = (sessionId) => sessionId === SESSION_1 ? slowFirst.promise : undefined;
    const worker = new ErasureWorker(
      { jobs, catalog, usage, executor },
      { jobBatchSize: 2 },
    );

    const run = worker.processOnce();
    await vi.waitFor(() => {
      expect(new Set(executor.drains)).toEqual(new Set([SESSION_1, SESSION_2]));
      expect(jobs.transitionCalls).toHaveLength(1);
    });
    expect(jobs.transitionCalls[0]?.authorization.requestId).toBe(secondRequestId);
    expect(jobs.transitionCalls[0]?.options.toStatus).toBe("tombstoning");

    slowFirst.resolve();
    await expect(run).resolves.toBe(2);
    expect(jobs.transitionCalls).toHaveLength(2);
  });

  it("isolates an acknowledgement failure to its claim while the rest of the batch completes", async () => {
    const jobs = new FakeJobs();
    const catalog = new FakeCatalog();
    const usage = new FakeUsage();
    const executor = new FakeExecutor();
    const warn = vi.fn();
    const firstRequestId = claim("draining").requestId;
    const secondRequestId = "erase_00000000-0000-4000-8000-000000000002";
    jobs.claimBatches.push([
      claim("draining"),
      claim("gated", {
        requestId: secondRequestId,
        subjectId: "user-b",
        claimToken: "claim-2",
      }),
    ]);
    catalog.listHook = () => ({
      data: [{ sessionId: SESSION_1, deleted: false, deletionGeneration: 0 }],
    });
    executor.drainHook = () => { throw new Error("transient operation failure"); };
    jobs.retryHook = (authorization) => {
      if (authorization.requestId === firstRequestId) throw new Error("retry store unavailable");
      return true;
    };
    const worker = new ErasureWorker(
      { jobs, catalog, usage, executor, logger: { warn } },
      { jobBatchSize: 2 },
    );

    await expect(worker.processOnce()).resolves.toBe(1);

    expect(jobs.retryCalls[0]?.authorization.requestId).toBe(firstRequestId);
    expect(jobs.transitionCalls).toHaveLength(1);
    expect(jobs.transitionCalls[0]?.authorization.requestId).toBe(secondRequestId);
    expect(warn).toHaveBeenCalledExactlyOnceWith("[erasure-worker] claim failed");
  });

  it.each([
    [new ErasureSessionExecutionError("owner_unavailable"), "owner_unavailable"],
    [{ code: "session_busy", message: "local raw detail" }, "drain_timeout"],
    [new Error("secret transport URL must not be persisted"), "temporary_failure"],
  ] as const)("persists only the bounded retry code for %p", async (error, expectedCode) => {
    const h = setup("draining", { retryBaseMs: 10, retryMaxMs: 100 });
    h.catalog.listHook = () => ({
      data: [{ sessionId: SESSION_1, deleted: false, deletionGeneration: 0 }],
    });
    h.executor.drainHook = () => { throw error; };

    await expect(h.worker.processOnce()).resolves.toBe(1);

    expect(h.jobs.retryCalls).toHaveLength(1);
    expect(h.jobs.retryCalls[0]?.options).toEqual({
      failedAtMs: 1_000,
      availableAtMs: 1_010,
      errorCode: expectedCode,
    });
    expect(JSON.stringify(h.jobs.retryCalls)).not.toContain("secret transport URL");
    expect(JSON.stringify(h.jobs.retryCalls)).not.toContain("local raw detail");
  });

  it("uses bounded exponential backoff from the durable claim attempt", async () => {
    const h = setup("draining", { retryBaseMs: 10, retryMaxMs: 50 });
    h.jobs.claimBatches[0] = [claim("draining", { attempts: 4 })];
    h.catalog.listHook = () => ({
      data: [{ sessionId: SESSION_1, deleted: false, deletionGeneration: 0 }],
    });
    h.executor.drainHook = () => { throw new Error("transient"); };

    await expect(h.worker.processOnce()).resolves.toBe(1);

    expect(h.jobs.retryCalls[0]?.options).toEqual({
      failedAtMs: 1_000,
      availableAtMs: 1_050,
      errorCode: "temporary_failure",
    });
  });

  it("silently stops when periodic renewal loses the claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const jobs = new FakeJobs();
    const catalog = new FakeCatalog();
    const usage = new FakeUsage();
    const executor = new FakeExecutor();
    jobs.claimBatches.push([claim("draining", { leaseUntilMs: 1_300 })]);
    jobs.renewHook = () => false;
    catalog.listHook = () => ({
      data: [{ sessionId: SESSION_1, deleted: false, deletionGeneration: 0 }],
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    executor.drainHook = () => held;
    const worker = new ErasureWorker(
      { jobs, catalog, usage, executor },
      { leaseMs: 300 },
    );

    const run = worker.processOnce();
    await flushMicrotasks();
    expect(executor.drains).toEqual([SESSION_1]);
    await vi.advanceTimersByTimeAsync(100);
    expect(jobs.renewCalls).toHaveLength(1);
    release();

    await expect(run).resolves.toBe(0);
    expect(jobs.transitionCalls).toEqual([]);
    expect(jobs.retryCalls).toEqual([]);
  });

  it("renews at lease/3 while an executor call is slow and retains the claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const jobs = new FakeJobs();
    const catalog = new FakeCatalog();
    const usage = new FakeUsage();
    const executor = new FakeExecutor();
    jobs.claimBatches.push([claim("draining", { leaseUntilMs: 1_300 })]);
    catalog.listHook = () => ({
      data: [{ sessionId: SESSION_1, deleted: false, deletionGeneration: 0 }],
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    executor.drainHook = () => held;
    const worker = new ErasureWorker(
      { jobs, catalog, usage, executor },
      { leaseMs: 300 },
    );

    const run = worker.processOnce();
    await flushMicrotasks();
    expect(executor.drains).toEqual([SESSION_1]);
    await vi.advanceTimersByTimeAsync(100);
    expect(jobs.renewCalls[0]?.options).toEqual({ nowMs: 1_100, leaseMs: 300 });
    release();

    await expect(run).resolves.toBe(1);
    expect(jobs.transitionCalls[0]?.options.toStatus).toBe("tombstoning");
  });

  it("uses a fresh clock reading for every catalog query instead of the claim timestamp", async () => {
    const jobs = new FakeJobs();
    const catalog = new FakeCatalog();
    const usage = new FakeUsage();
    const executor = new FakeExecutor();
    jobs.claimBatches.push([claim("tombstoning")]);
    let now = 1_000;
    const worker = new ErasureWorker({
      jobs,
      catalog,
      usage,
      executor,
      clock: { now: () => ++now },
    });

    await expect(worker.processOnce()).resolves.toBe(1);

    expect(jobs.claimCalls[0]?.nowMs).toBe(1_001);
    expect(catalog.listCalls[0]?.query.nowMs).toBe(1_002);
    expect(catalog.progressCalls[0]?.query.nowMs).toBe(1_003);
    expect(jobs.transitionCalls[0]?.options.atMs).toBe(1_004);
  });

  it("does not retry after a transition CAS reports that the claim was lost", async () => {
    const h = setup("gated");
    h.jobs.transitionHook = () => false;

    await expect(h.worker.processOnce()).resolves.toBe(0);

    expect(h.jobs.transitionCalls).toHaveLength(1);
    expect(h.jobs.retryCalls).toEqual([]);
  });

  it("leaves a batch for lease expiry when stop wins the claim boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const jobs = new FakeJobs();
    const catalog = new FakeCatalog();
    const usage = new FakeUsage();
    const executor = new FakeExecutor();
    const claimed = deferred<ErasureJobClaim[]>();
    jobs.claimHook = () => claimed.promise;
    const worker = new ErasureWorker({ jobs, catalog, usage, executor });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.claimCalls).toHaveLength(1);
    const stopping = worker.stop();
    claimed.resolve([claim("gated")]);
    await stopping;

    expect(jobs.renewCalls).toEqual([]);
    expect(jobs.transitionCalls).toEqual([]);
    expect(jobs.retryCalls).toEqual([]);
    expect(catalog.listCalls).toEqual([]);
  });

  it("waits for the current session call after stop but neither traverses nor acknowledges it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const jobs = new FakeJobs();
    const catalog = new FakeCatalog();
    const usage = new FakeUsage();
    const executor = new FakeExecutor();
    jobs.claimBatches.push([claim("draining")]);
    catalog.listHook = () => ({
      data: [
        { sessionId: SESSION_1, deleted: false, deletionGeneration: 0 },
        { sessionId: SESSION_2, deleted: false, deletionGeneration: 0 },
      ],
    });
    const activeCall = deferred<void>();
    executor.drainHook = (sessionId) => sessionId === SESSION_1 ? activeCall.promise : undefined;
    const worker = new ErasureWorker({ jobs, catalog, usage, executor });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(executor.drains).toEqual([SESSION_1]);

    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await flushMicrotasks();
    expect(stopped).toBe(false);
    activeCall.reject(new ErasureSessionExecutionError("owner_unavailable"));
    await stopping;

    expect(executor.drains).toEqual([SESSION_1]);
    expect(jobs.transitionCalls).toEqual([]);
    expect(jobs.retryCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(jobs.claimCalls).toHaveLength(1);
  });
});
