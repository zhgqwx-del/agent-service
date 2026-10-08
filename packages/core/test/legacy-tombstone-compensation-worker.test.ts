import { describe, expect, it, vi } from "vitest";
import {
  LegacyTombstoneChildPendingError,
  type ActivateLegacyTombstoneCutoverInput,
  type ClaimLegacyTombstoneCompensationsOptions,
  type LegacyTombstoneCompensationAudit,
  type LegacyTombstoneCompensationAuthorization,
  type LegacyTombstoneCompensationClaim,
  type LegacyTombstoneCompensationJobRecord,
  type LegacyTombstoneCompensationResult,
  type LegacyTombstoneCompensationStore,
  type LegacyTombstoneCutoverRecord,
  type RenewLegacyTombstoneCompensationOptions,
  type RetryLegacyTombstoneCompensationOptions,
  type ScheduleLegacyTombstoneCandidatesOptions,
  type ScheduleLegacyTombstoneCompensationInput,
  type ErasureWriteAuthorization,
} from "@agent-service/store";
import { LegacyTombstoneCompensationWorker } from "../src/index.js";

const SESSION_1 = "sess_00000000-0000-4000-8000-000000000001";
const SESSION_2 = "sess_00000000-0000-4000-8000-000000000002";
const JOB_1 = "ltc_00000000-0000-4000-8000-000000000001";
const JOB_2 = "ltc_00000000-0000-4000-8000-000000000002";

function claim(jobId = JOB_1, sessionId = SESSION_1): LegacyTombstoneCompensationClaim {
  return {
    jobId,
    tenantId: "tenant-a",
    userId: "user-a",
    sessionId,
    cutoverGeneration: 1,
    legacyDeletedAtMs: 100,
    availableAtMs: 1_000,
    attempts: 1,
    claimToken: "claim-token",
    claimAttempt: 1,
    leaseUntilMs: 31_000,
  };
}

class FakeStore implements LegacyTombstoneCompensationStore {
  cutover: LegacyTombstoneCutoverRecord | null = null;
  activateCalls: ActivateLegacyTombstoneCutoverInput[] = [];
  scheduleCalls: ScheduleLegacyTombstoneCandidatesOptions[] = [];
  claimCalls: ClaimLegacyTombstoneCompensationsOptions[] = [];
  renewCalls: Array<{
    authorization: LegacyTombstoneCompensationAuthorization;
    options: RenewLegacyTombstoneCompensationOptions;
  }> = [];
  retryCalls: Array<{
    authorization: LegacyTombstoneCompensationAuthorization;
    options: RetryLegacyTombstoneCompensationOptions;
  }> = [];
  completeCalls: LegacyTombstoneCompensationAuthorization[] = [];
  claims: LegacyTombstoneCompensationClaim[] = [];
  activateHook?: (input: ActivateLegacyTombstoneCutoverInput) => Promise<LegacyTombstoneCutoverRecord>;
  renewHook: (
    authorization: LegacyTombstoneCompensationAuthorization,
  ) => Promise<boolean> | boolean = () => true;
  retryHook: (
    authorization: LegacyTombstoneCompensationAuthorization,
    options: RetryLegacyTombstoneCompensationOptions,
  ) => Promise<boolean> | boolean = () => true;
  completeHook?: (
    authorization: LegacyTombstoneCompensationAuthorization,
  ) => Promise<LegacyTombstoneCompensationResult | null> | LegacyTombstoneCompensationResult | null;

  async getLegacyTombstoneCutover(): Promise<LegacyTombstoneCutoverRecord | null> {
    return this.cutover ? structuredClone(this.cutover) : null;
  }

  async activateLegacyTombstoneCutover(
    input: ActivateLegacyTombstoneCutoverInput,
  ): Promise<LegacyTombstoneCutoverRecord> {
    this.activateCalls.push(structuredClone(input));
    if (this.activateHook) return await this.activateHook(input);
    this.cutover = {
      cutoverId: input.cutoverId,
      generation: 1,
      activatedByKeyId: input.actorKeyId,
      activatedAtMs: input.atMs,
    };
    return structuredClone(this.cutover);
  }

  async scheduleLegacyTombstoneCompensation(
    _authorization: ErasureWriteAuthorization,
    _input: ScheduleLegacyTombstoneCompensationInput,
  ): Promise<LegacyTombstoneCompensationJobRecord> {
    throw new Error("not used by the global worker");
  }

  async scheduleLegacyTombstoneCandidates(
    options: ScheduleLegacyTombstoneCandidatesOptions,
  ): Promise<LegacyTombstoneCompensationJobRecord[]> {
    this.scheduleCalls.push(structuredClone(options));
    return [];
  }

  async getLegacyTombstoneCompensationJob(): Promise<LegacyTombstoneCompensationJobRecord | null> {
    return null;
  }

  async listLegacyTombstoneCompensationAudits(): Promise<LegacyTombstoneCompensationAudit[]> {
    return [];
  }

  async claimLegacyTombstoneCompensations(
    options: ClaimLegacyTombstoneCompensationsOptions,
  ): Promise<LegacyTombstoneCompensationClaim[]> {
    this.claimCalls.push(structuredClone(options));
    return structuredClone(this.claims);
  }

  async renewLegacyTombstoneCompensation(
    authorization: LegacyTombstoneCompensationAuthorization,
    options: RenewLegacyTombstoneCompensationOptions,
  ): Promise<boolean> {
    this.renewCalls.push({
      authorization: structuredClone(authorization),
      options: structuredClone(options),
    });
    return await this.renewHook(authorization);
  }

  async retryLegacyTombstoneCompensation(
    authorization: LegacyTombstoneCompensationAuthorization,
    options: RetryLegacyTombstoneCompensationOptions,
  ): Promise<boolean> {
    this.retryCalls.push({
      authorization: structuredClone(authorization),
      options: structuredClone(options),
    });
    return await this.retryHook(authorization, options);
  }

  async completeLegacyTombstoneCompensation(
    authorization: LegacyTombstoneCompensationAuthorization,
  ): Promise<LegacyTombstoneCompensationResult | null> {
    this.completeCalls.push(structuredClone(authorization));
    if (this.completeHook) return await this.completeHook(authorization);
    return {
      outcome: "compensated",
      sessionId: authorization.sessionId,
      deletionGeneration: 1,
      eventSeq: 1,
    };
  }
}

describe("LegacyTombstoneCompensationWorker", () => {
  it("does not activate the irreversible cutover before the V2 fleet barrier opens", async () => {
    const store = new FakeStore();
    const worker = new LegacyTombstoneCompensationWorker({
      store,
      canClaim: async () => false,
      clock: { now: () => 1_000 },
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(store.activateCalls).toEqual([]);
    expect(store.scheduleCalls).toEqual([]);
    expect(store.claimCalls).toEqual([]);
  });

  it("activates once, schedules globally, renews and completes a claimed job", async () => {
    const store = new FakeStore();
    store.claims = [claim()];
    const worker = new LegacyTombstoneCompensationWorker({
      store,
      canClaim: async () => true,
      clock: { now: () => 1_000 },
    }, { batchSize: 7, leaseMs: 2_000 });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(store.activateCalls).toEqual([expect.objectContaining({
      expectedGeneration: 0,
      actorKeyId: "system-legacy-tombstone-worker",
      atMs: 1_000,
    })]);
    expect(store.scheduleCalls).toEqual([{
      cutoverGeneration: 1,
      actorKeyId: "system-legacy-tombstone-worker",
      nowMs: 1_000,
      limit: 7,
    }]);
    expect(store.claimCalls[0]).toMatchObject({ nowMs: 1_000, limit: 7, leaseMs: 2_000 });
    expect(store.renewCalls).toHaveLength(1);
    expect(store.completeCalls).toEqual([expect.objectContaining({
      jobId: JOB_1,
      sessionId: SESSION_1,
      claimAttempt: 1,
    })]);
  });

  it("recovers an activation commit whose response was lost by rereading the durable cutover", async () => {
    const store = new FakeStore();
    store.activateHook = async (input) => {
      store.cutover = {
        cutoverId: input.cutoverId,
        generation: 1,
        activatedByKeyId: input.actorKeyId,
        activatedAtMs: input.atMs,
      };
      throw new Error("response lost");
    };
    const worker = new LegacyTombstoneCompensationWorker({
      store,
      canClaim: async () => true,
      clock: { now: () => 1_000 },
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(store.scheduleCalls).toHaveLength(1);
    expect(store.claimCalls).toHaveLength(1);
  });

  it("backs off a child dependency without blocking a neighboring claim", async () => {
    let nowMs = 1_000;
    const store = new FakeStore();
    store.cutover = {
      cutoverId: "legacy-session-tombstone-v1",
      generation: 1,
      activatedByKeyId: "operator",
      activatedAtMs: 900,
    };
    store.claims = [claim(), claim(JOB_2, SESSION_2)];
    store.completeHook = (authorization) => {
      if (authorization.jobId === JOB_1) throw new LegacyTombstoneChildPendingError(SESSION_1);
      return {
        outcome: "terminal_incident",
        jobId: authorization.jobId,
        reasonCode: "proof_conflict",
        evidenceSha256: "0".repeat(64),
      };
    };
    const worker = new LegacyTombstoneCompensationWorker({
      store,
      canClaim: async () => true,
      clock: { now: () => nowMs },
    }, { retryBaseMs: 250, retryMaxMs: 1_000 });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(store.completeCalls).toHaveLength(2);
    expect(store.retryCalls).toEqual([expect.objectContaining({
      options: {
        failedAtMs: 1_000,
        availableAtMs: 1_250,
        errorCode: "child_pending",
      },
    })]);
    nowMs = 2_000;
  });

  it("does not complete a lost exact claim while a neighboring claim still completes", async () => {
    const store = new FakeStore();
    store.cutover = {
      cutoverId: "legacy-session-tombstone-v1",
      generation: 1,
      activatedByKeyId: "operator",
      activatedAtMs: 900,
    };
    store.claims = [claim(), claim(JOB_2, SESSION_2)];
    store.renewHook = (authorization) => authorization.jobId !== JOB_1;
    const worker = new LegacyTombstoneCompensationWorker({
      store,
      canClaim: async () => true,
      clock: { now: () => 1_000 },
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(store.completeCalls).toEqual([expect.objectContaining({
      jobId: JOB_2,
      sessionId: SESSION_2,
    })]);
    expect(store.retryCalls).toEqual([]);
  });

  it("isolates a retry acknowledgement failure and logs only a fixed redacted warning", async () => {
    const store = new FakeStore();
    store.cutover = {
      cutoverId: "legacy-session-tombstone-v1",
      generation: 1,
      activatedByKeyId: "operator",
      activatedAtMs: 900,
    };
    store.claims = [claim(), claim(JOB_2, SESSION_2)];
    store.completeHook = (authorization) => {
      if (authorization.jobId === JOB_1) throw new Error("mysql://complete-secret@private/db");
      return {
        outcome: "compensated",
        sessionId: authorization.sessionId,
        deletionGeneration: 1,
        eventSeq: 2,
      };
    };
    store.retryHook = (authorization) => {
      if (authorization.jobId === JOB_1) throw new Error("mysql://retry-secret@private/db");
      return true;
    };
    const logger = { warn: vi.fn() };
    const worker = new LegacyTombstoneCompensationWorker({
      store,
      canClaim: async () => true,
      clock: { now: () => 1_000 },
      logger,
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(store.retryCalls[0]?.options.errorCode).toBe("temporary_failure");
    expect(store.completeCalls).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      "[legacy-tombstone-compensation] claim failed",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("complete-secret");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("retry-secret");
  });
});
