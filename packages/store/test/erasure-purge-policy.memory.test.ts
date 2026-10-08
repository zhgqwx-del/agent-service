import { emptyUsage, type Session } from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  ErasurePurgeEvidenceChangedError,
  MemorySessionStore,
  billingUsageFactFromLedger,
  erasurePolicyDecisionSha256,
  erasurePurgeAuthoritySha256,
  newErasureRequestId,
  userErasureRequestHash,
  type ErasureJobClaim,
  type ErasurePolicyEvaluationAuthorization,
  type RetentionPolicyDocumentV1,
  type UsageLedgerEntry,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE = 1_000;

function policy(overrides: Partial<RetentionPolicyDocumentV1> = {}): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: 0,
    userErasureGraceMs: 0,
    operationalUsageRetentionMs: 0,
    idempotencyReceiptRetentionMs: 0,
    billingFactRetentionMs: null,
    lifecycleAuditRetentionMs: null,
    exportArtifactTtlMs: null,
    ...overrides,
  };
}

function jobAuthorization(claim: ErasureJobClaim) {
  return {
    tenantId: claim.tenantId,
    subjectKind: claim.subjectKind,
    subjectId: claim.subjectId,
    requestId: claim.requestId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

function evaluationAuthorization(
  claim: Awaited<ReturnType<MemorySessionStore["claimErasurePolicyEvaluations"]>>[number],
): ErasurePolicyEvaluationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectKind: claim.subjectKind,
    subjectId: claim.subjectId,
    subjectGeneration: claim.subjectGeneration,
    buildGeneration: claim.buildGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.claimAttempt,
  };
}

async function tombstoneAndReconcile(
  store: MemorySessionStore,
  tenantId: string,
  userId: string,
  options: { stageExpiredBlob?: boolean } = {},
): Promise<{
  session: Session;
  reconciliation: Awaited<ReturnType<MemorySessionStore["reconcileSessionUsage"]>>;
  blobId?: string;
}> {
  const session: Session = {
    ...mkSession(tenantId, userId),
    createdAtMs: BASE,
    updatedAtMs: BASE,
  };
  await store.createSession(session);
  let blobId: string | undefined;
  if (options.stageExpiredBlob) {
    blobId = newId("blob");
    await store.stageBlob({
      owner: { tenantId, userId },
      sessionId: session.id,
      fence: 1,
      blobId,
      purpose: "tool_output",
      storageBackend: "memory-v1",
      storageFormat: BLOB_STORAGE_FORMAT,
      storageKey: `objects/${blobId.slice(5)}`,
      uploadToken: `upload-${blobId.slice(5)}`,
      createdAtMs: BASE,
      stagingExpiresAtMs: BASE + 50,
    });
  }
  store.usageLedger.push({
    tenantId,
    userId,
    sessionId: session.id,
    turnId: newId("turn"),
    step: 1,
    provider: "provider-a",
    model: "model-a",
    usage: { ...emptyUsage(), inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    createdAtMs: BASE + 10,
  } satisfies UsageLedgerEntry);
  await store.commit({
    sessionId: session.id,
    fence: 1,
    lifecycle: {
      type: "tombstone",
      tenantId,
      userId,
      deletionGeneration: 1,
      atMs: BASE + 100,
    },
    events: [{
      type: "session/deleted",
      sessionId: session.id,
      deletionGeneration: 1,
      emittedAtMs: BASE + 100,
    }],
  });
  const reconciliation = await store.reconcileSessionUsage({
    tenantId,
    userId,
    sessionId: session.id,
    deletionGeneration: 1,
    nowMs: BASE + 200,
  });
  return { session, reconciliation, ...(blobId === undefined ? {} : { blobId }) };
}

async function awaitingRequest(
  store: MemorySessionStore,
  options: {
    tenantId: string;
    userId: string;
    policy?: RetentionPolicyDocumentV1;
    policyAtMs?: number;
    requestAtMs?: number;
  },
) {
  const requestAtMs = options.requestAtMs ?? BASE + 300;
  let policyRecord: Awaited<ReturnType<MemorySessionStore["putRetentionPolicy"]>> | undefined;
  if (options.policy) {
    policyRecord = await store.putRetentionPolicy({
      tenantId: options.tenantId,
      policyVersion: "policy-v1",
      policy: options.policy,
      actorKeyId: "policy-admin",
      atMs: options.policyAtMs ?? BASE + 1,
    });
    await store.activateRetentionPolicy({
      tenantId: options.tenantId,
      policyVersion: policyRecord.policyVersion,
      expectedControlGeneration: 0,
      actorKeyId: "policy-admin",
      atMs: options.policyAtMs ?? BASE + 2,
    });
  }
  const input = {
    requestId: newErasureRequestId(),
    tenantId: options.tenantId,
    userId: options.userId,
    requestedByKeyId: "erasure-admin",
    idempotencyKey: `erase-${options.userId}`,
    requestHash: userErasureRequestHash(options.tenantId, options.userId),
    atMs: requestAtMs,
  };
  await store.requestUserErasure(input);
  const transitions = [
    ["gated", "draining"],
    ["draining", "tombstoning"],
    ["tombstoning", "reconciling_usage"],
    ["reconciling_usage", "awaiting_purge_policy"],
  ] as const;
  for (const [index, [fromStatus, toStatus]] of transitions.entries()) {
    const atMs = requestAtMs + index + 1;
    const claim = (await store.claimErasureJobs({
      nowMs: atMs,
      limit: 1,
      leaseMs: 50,
      claimToken: `erasure-worker-${index}`,
    }))[0]!;
    expect(claim.status).toBe(fromStatus);
    expect(await store.transitionErasureJob(jobAuthorization(claim), {
      fromStatus,
      toStatus,
      atMs,
      ...(toStatus === "awaiting_purge_policy" ? {} : { availableAtMs: atMs }),
    })).toBe(true);
  }
  return { input, policyRecord };
}

async function claimEvaluation(store: MemorySessionStore, nowMs: number) {
  const claim = (await store.claimErasurePolicyEvaluations({
    nowMs,
    limit: 1,
    leaseMs: 100,
    claimToken: "evaluation-worker-0001",
  }))[0]!;
  return { claim, authorization: evaluationAuthorization(claim) };
}

describe("MemorySessionStore purge-policy evaluation", () => {
  it("atomically schedules the first job and fences claim-token ABA across retry/takeover", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-queue";
    const userId = "user-eval-queue";
    await tombstoneAndReconcile(store, tenantId, userId);
    const { input } = await awaitingRequest(store, { tenantId, userId, policy: policy() });
    expect(await store.getErasurePolicyEvaluationJob(input.requestId)).toMatchObject({
      buildGeneration: 1,
      targetCount: 0,
      attempts: 0,
      availableAtMs: BASE + 304,
    });
    expect(await store.scheduleAwaitingErasurePolicyEvaluations({
      nowMs: BASE + 305,
      limit: 10,
    })).toBe(0);

    const first = (await store.claimErasurePolicyEvaluations({
      nowMs: BASE + 304,
      limit: 1,
      leaseMs: 10,
      claimToken: "evaluation-reused-token",
    }))[0]!;
    const taken = (await store.claimErasurePolicyEvaluations({
      nowMs: BASE + 314,
      limit: 1,
      leaseMs: 20,
      claimToken: "evaluation-reused-token",
    }))[0]!;
    expect(taken.claimAttempt).toBe(2);
    expect(await store.renewErasurePolicyEvaluation(evaluationAuthorization(first), {
      nowMs: BASE + 314,
      leaseMs: 50,
    })).toBe(false);
    expect(await store.retryErasurePolicyEvaluation(evaluationAuthorization(taken), {
      failedAtMs: BASE + 315,
      availableAtMs: BASE + 320,
      errorCode: "temporary_failure",
    })).toBe(true);
    expect(await store.claimErasurePolicyEvaluations({
      nowMs: BASE + 319,
      limit: 1,
      leaseMs: 10,
      claimToken: "evaluation-too-early",
    })).toEqual([]);
    expect((await store.claimErasurePolicyEvaluations({
      nowMs: BASE + 320,
      limit: 1,
      leaseMs: 10,
      claimToken: "evaluation-after-retry",
    }))[0]).toMatchObject({ claimAttempt: 3 });
  });

  it("builds request-bound deadline evidence and seals only non-executable authority", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-authority";
    const userId = "user-eval-authority";
    const { session } = await tombstoneAndReconcile(store, tenantId, userId);
    const { input } = await awaitingRequest(store, { tenantId, userId, policy: policy() });
    const { authorization } = await claimEvaluation(store, BASE + 304);
    expect(await store.buildErasurePurgeTargetPage(authorization, {
      nowMs: BASE + 305,
      limit: 10,
    })).toMatchObject({ built: 1, done: true, targetCount: 1 });
    const [target] = await store.listErasurePurgeTargetEvidence(input.requestId, 1);
    expect(target).toMatchObject({
      sessionId: session.id,
      deletedAtMs: BASE + 100,
      sessionContentDeadlineMs: BASE + 100,
      operationalUsageVerifiedAtMs: BASE + 200,
      operationalUsageDeadlineMs: BASE + 200,
      idempotencyReceiptCount: 0,
      exportArtifactDisposition: "not_applicable",
      billingFactDisposition: "retained",
      lifecycleAuditDisposition: "retained",
      issueCodes: [],
    });
    const sealed = await store.sealErasurePurgeAuthority(authorization, { nowMs: BASE + 305 });
    expect(sealed.decision.decision).toBe("eligible_execution_disabled");
    expect(sealed.authority).toMatchObject({ authorityGeneration: 1, targetCount: 1 });
    expect(sealed.authority).not.toHaveProperty("claimToken");
    expect(sealed.control).not.toHaveProperty("availableAtMs");
    expect(await store.getValidatedErasurePurgeAuthority(input.requestId)).toEqual(sealed.authority);
    expect(await store.getErasureCompletionReadiness(input.requestId)).toMatchObject({
      complete: false,
      missing: expect.arrayContaining([
        "trusted_clock_linearization",
        "ready_blob_physical_acks",
        "redis_cleanup",
        "restore_ledger_ack",
      ]),
    });

    // Live inventory drift cannot leave a previously sealed authority valid.
    const injected = { ...mkSession(tenantId, userId), id: newId("sess") };
    store.sessions.set(injected.id, injected);
    expect(await store.getValidatedErasurePurgeAuthority(input.requestId)).toBeNull();
  });

  it("rejects a hash-consistent authority whose deadlines were not derived from policy", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-forged-deadline";
    const userId = "user-eval-forged-deadline";
    await tombstoneAndReconcile(store, tenantId, userId);
    const { input } = await awaitingRequest(store, { tenantId, userId, policy: policy() });
    const claimed = await claimEvaluation(store, BASE + 304);
    await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
    await store.sealErasurePurgeAuthority(claimed.authorization, { nowMs: BASE + 306 });

    const decisions = store.erasurePolicyEvaluationDecisions.get(input.requestId)!;
    const decisionWithoutHash = { ...decisions[0]! };
    delete (decisionWithoutHash as Partial<typeof decisionWithoutHash>).afterSha256;
    const forgedDecisionWithoutHash = {
      ...decisionWithoutHash,
      userGraceDeadlineMs: 0,
      eligibilityDeadlineMs: 0,
    };
    const forgedDecision = {
      ...forgedDecisionWithoutHash,
      afterSha256: erasurePolicyDecisionSha256(forgedDecisionWithoutHash),
    };
    store.erasurePolicyEvaluationDecisions.set(input.requestId, [forgedDecision]);
    const authorities = store.erasurePurgeAuthorities.get(input.requestId)!;
    const authorityWithoutHash = { ...authorities[0]! };
    delete (authorityWithoutHash as Partial<typeof authorityWithoutHash>).authoritySha256;
    const forgedAuthorityWithoutHash = {
      ...authorityWithoutHash,
      userGraceDeadlineMs: 0,
      eligibilityDeadlineMs: 0,
      decisionSha256: forgedDecision.afterSha256,
    };
    const forgedAuthority = {
      ...forgedAuthorityWithoutHash,
      authoritySha256: erasurePurgeAuthoritySha256(forgedAuthorityWithoutHash),
    };
    store.erasurePurgeAuthorities.set(input.requestId, [forgedAuthority]);
    store.erasurePurgeAuthorityControls.set(input.requestId, {
      requestId: input.requestId,
      authorityGeneration: 1,
      activeAuthoritySha256: forgedAuthority.authoritySha256,
      updatedAtMs: forgedAuthority.createdAtMs,
    });
    await expect(store.getValidatedErasurePurgeAuthority(input.requestId))
      .rejects.toThrow("deadline chain is corrupt");
  });

  it("clamps sealed decision and authority timestamps to a future-skewed policy record", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-policy-clock";
    const userId = "user-eval-policy-clock";
    await tombstoneAndReconcile(store, tenantId, userId);
    const policyAtMs = BASE + 500;
    const { input, policyRecord } = await awaitingRequest(store, {
      tenantId,
      userId,
      policy: policy(),
      policyAtMs,
    });
    expect(policyRecord?.createdAtMs).toBe(policyAtMs);
    const claimed = await claimEvaluation(store, BASE + 304);
    await store.buildErasurePurgeTargetPage(claimed.authorization, {
      nowMs: BASE + 305,
      limit: 10,
    });
    const sealed = await store.sealErasurePurgeAuthority(claimed.authorization, {
      nowMs: BASE + 306,
    });
    expect(sealed.decision.decidedAtMs).toBe(policyAtMs);
    expect(sealed.authority?.createdAtMs).toBe(policyAtMs);
    expect(await store.getErasurePolicyEvaluationJob(input.requestId)).toMatchObject({
      sealedAtMs: policyAtMs,
      updatedAtMs: policyAtMs,
    });
  });

  it("rejects a tampered current-build target before appending seal history", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-target-tamper";
    const userId = "user-eval-target-tamper";
    await tombstoneAndReconcile(store, tenantId, userId);
    const { input } = await awaitingRequest(store, { tenantId, userId, policy: policy() });
    const claimed = await claimEvaluation(store, BASE + 304);
    await store.buildErasurePurgeTargetPage(claimed.authorization, {
      nowMs: BASE + 305,
      limit: 10,
    });
    const [entry] = [...store.erasurePurgeTargets.entries()];
    expect(entry).toBeDefined();
    const [key, target] = entry!;
    store.erasurePurgeTargets.set(key, {
      ...target,
      issueCodes: ["blob_invalid"],
      // Deliberately retain the old evidence hash: Memory must reject the preimage mismatch
      // before it appends a decision, control update, or authority.
    });
    await expect(store.sealErasurePurgeAuthority(claimed.authorization, {
      nowMs: BASE + 306,
    })).rejects.toThrow("stored erasure purge target evidence is invalid");
    expect(store.erasurePolicyEvaluationDecisions.get(input.requestId)).toBeUndefined();
    expect(store.erasurePurgeAuthorities.get(input.requestId)).toBeUndefined();
    expect(store.erasurePurgeAuthorityControls.get(input.requestId)).toBeUndefined();
    const job = await store.getErasurePolicyEvaluationJob(input.requestId);
    expect(job).toMatchObject({ claimToken: claimed.authorization.claimToken });
    expect(job).not.toHaveProperty("sealedAtMs");
  });

  it("invalidates hold ABA and deterministically rebuilds a new authority generation", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-hold-aba";
    const userId = "user-eval-hold-aba";
    await tombstoneAndReconcile(store, tenantId, userId);
    const { input } = await awaitingRequest(store, { tenantId, userId, policy: policy() });
    let claimed = await claimEvaluation(store, BASE + 304);
    await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
    const first = await store.sealErasurePurgeAuthority(claimed.authorization, { nowMs: BASE + 305 });
    expect(first.authority?.authorityGeneration).toBe(1);

    await store.setLegalHold({
      tenantId,
      holdId: "hold_eval_aba",
      subjectKind: "user",
      subjectId: userId,
      reasonCode: "litigation",
      expectedControlGeneration: 0,
      actorKeyId: "legal-admin",
      atMs: BASE + 310,
    });
    expect(await store.getValidatedErasurePurgeAuthority(input.requestId)).toBeNull();
    const controls = store.erasurePurgeAuthorityControls;
    Object.defineProperty(controls, "set", {
      configurable: true,
      value: () => { throw new Error("injected authority invalidation failure"); },
    });
    await expect(store.scheduleAwaitingErasurePolicyEvaluations({
      nowMs: BASE + 311,
      limit: 10,
    })).rejects.toThrow("injected authority invalidation failure");
    Reflect.deleteProperty(controls, "set");
    expect(await store.getErasurePolicyEvaluationJob(input.requestId)).toMatchObject({
      buildGeneration: 1,
      sealedAtMs: BASE + 305,
    });
    expect(store.erasurePurgeAuthorityControls.get(input.requestId)).toMatchObject({
      authorityGeneration: 1,
      activeAuthoritySha256: first.authority?.authoritySha256,
    });
    expect(await store.scheduleAwaitingErasurePolicyEvaluations({
      nowMs: BASE + 311,
      limit: 10,
    })).toBe(1);
    expect(store.erasurePurgeAuthorityControls.get(input.requestId)).toEqual({
      requestId: input.requestId,
      authorityGeneration: 1,
      updatedAtMs: BASE + 311,
    });
    claimed = await claimEvaluation(store, BASE + 311);
    expect(claimed.claim.buildGeneration).toBe(2);
    await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 312, limit: 10 });
    expect((await store.sealErasurePurgeAuthority(claimed.authorization, {
      nowMs: BASE + 312,
    })).decision.decision).toBe("held");
    expect(store.erasurePurgeAuthorityControls.get(input.requestId)).not.toHaveProperty(
      "activeAuthoritySha256",
    );

    await store.releaseLegalHold({
      tenantId,
      holdId: "hold_eval_aba",
      expectedControlGeneration: 1,
      reasonCode: "matter_closed",
      actorKeyId: "legal-admin",
      atMs: BASE + 320,
    });
    expect(await store.scheduleAwaitingErasurePolicyEvaluations({
      nowMs: BASE + 321,
      limit: 10,
    })).toBe(1);
    claimed = await claimEvaluation(store, BASE + 321);
    expect(claimed.claim.buildGeneration).toBe(3);
    await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 322, limit: 10 });
    const resealed = await store.sealErasurePurgeAuthority(claimed.authorization, {
      nowMs: BASE + 322,
    });
    expect(resealed.authority?.authorityGeneration).toBe(2);
    expect(await store.getValidatedErasurePurgeAuthority(input.requestId)).toEqual(resealed.authority);
  });

  it("requeues waiting only at its durable deadline and does not busy-loop terminal denials", async () => {
    const waiting = new MemorySessionStore();
    const tenantId = "tenant-eval-waiting";
    const userId = "user-eval-waiting";
    await tombstoneAndReconcile(waiting, tenantId, userId);
    const { input } = await awaitingRequest(waiting, {
      tenantId,
      userId,
      policy: policy({ userErasureGraceMs: 100 }),
      requestAtMs: BASE + 300,
    });
    let claimed = await claimEvaluation(waiting, BASE + 304);
    await waiting.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
    expect((await waiting.sealErasurePurgeAuthority(claimed.authorization, {
      nowMs: BASE + 305,
    })).decision).toMatchObject({ decision: "waiting", eligibilityDeadlineMs: BASE + 400 });
    expect(await waiting.scheduleAwaitingErasurePolicyEvaluations({
      nowMs: BASE + 399,
      limit: 10,
    })).toBe(0);
    expect(await waiting.scheduleAwaitingErasurePolicyEvaluations({
      nowMs: BASE + 400,
      limit: 10,
    })).toBe(1);
    claimed = await claimEvaluation(waiting, BASE + 400);
    await waiting.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 400, limit: 10 });
    expect((await waiting.sealErasurePurgeAuthority(claimed.authorization, {
      nowMs: BASE + 400,
    })).decision.decision).toBe("eligible_execution_disabled");
    expect(await waiting.getValidatedErasurePurgeAuthority(input.requestId)).not.toBeNull();

    const unbound = new MemorySessionStore();
    const unboundTenant = "tenant-eval-unbound";
    const unboundUser = "user-eval-unbound";
    await tombstoneAndReconcile(unbound, unboundTenant, unboundUser);
    await awaitingRequest(unbound, { tenantId: unboundTenant, userId: unboundUser });
    const unboundClaim = await claimEvaluation(unbound, BASE + 304);
    expect((await unbound.sealErasurePurgeAuthority(unboundClaim.authorization, {
      nowMs: BASE + 305,
    })).decision.decision).toBe("unbound");
    expect(await unbound.scheduleAwaitingErasurePolicyEvaluations({
      nowMs: BASE + 10_000,
      limit: 10,
    })).toBe(0);

    const empty = new MemorySessionStore();
    const emptyRequest = await awaitingRequest(empty, {
      tenantId: "tenant-eval-empty",
      userId: "user-eval-empty",
      policy: policy({
        sessionContentRetentionMs: null,
        operationalUsageRetentionMs: null,
        idempotencyReceiptRetentionMs: null,
      }),
    });
    const emptyClaim = await claimEvaluation(empty, BASE + 304);
    expect(await empty.buildErasurePurgeTargetPage(emptyClaim.authorization, {
      nowMs: BASE + 305,
      limit: 10,
    })).toMatchObject({ built: 0, done: true, targetCount: 0 });
    expect((await empty.sealErasurePurgeAuthority(emptyClaim.authorization, {
      nowMs: BASE + 306,
    })).decision.decision).toBe("unconfigured");
    expect(await empty.scheduleAwaitingErasurePolicyEvaluations({
      nowMs: BASE + 10_000,
      limit: 10,
    })).toBe(0);
    expect(await empty.getValidatedErasurePurgeAuthority(emptyRequest.input.requestId)).toBeNull();
  });

  it("rebuilds a fresh generation after evidence changes before and after sealing", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-evidence-drift";
    const userId = "user-eval-evidence-drift";
    const { session, reconciliation } = await tombstoneAndReconcile(store, tenantId, userId);
    const { input } = await awaitingRequest(store, { tenantId, userId, policy: policy() });
    let claimed = await claimEvaluation(store, BASE + 304);
    await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });

    await store.anonymizeSessionUsage({
      tenantId,
      userId,
      sessionId: session.id,
      deletionGeneration: 1,
      expectedChecksum: reconciliation.checksum,
      nowMs: BASE + 306,
      enabled: true,
    });
    await expect(store.sealErasurePurgeAuthority(claimed.authorization, {
      nowMs: BASE + 307,
    })).rejects.toBeInstanceOf(ErasurePurgeEvidenceChangedError);
    expect(await store.retryErasurePolicyEvaluation(claimed.authorization, {
      failedAtMs: BASE + 307,
      availableAtMs: BASE + 308,
      errorCode: "evidence_changed",
    })).toBe(true);
    expect(await store.getErasurePolicyEvaluationJob(input.requestId)).toMatchObject({
      buildGeneration: 2,
      targetCount: 0,
      attempts: 0,
      lastErrorCode: "evidence_changed",
    });
    expect(await store.listErasurePurgeTargetEvidence(input.requestId, 1)).toHaveLength(1);

    claimed = await claimEvaluation(store, BASE + 308);
    await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 309, limit: 10 });
    const sealed = await store.sealErasurePurgeAuthority(claimed.authorization, {
      nowMs: BASE + 310,
    });
    expect(sealed.authority?.buildGeneration).toBe(2);

    store.idem.set(JSON.stringify([tenantId, userId, session.id, "late-receipt"]), {
      value: null,
      expiresAt: BASE + 312,
    });
    expect(await store.getValidatedErasurePurgeAuthority(input.requestId)).toBeNull();
    expect(await store.scheduleAwaitingErasurePolicyEvaluations({
      nowMs: BASE + 311,
      limit: 10,
    })).toBe(1);
    expect(store.erasurePurgeAuthorityControls.get(input.requestId)).toMatchObject({
      authorityGeneration: 1,
      updatedAtMs: BASE + 311,
    });
    expect(store.erasurePurgeAuthorityControls.get(input.requestId)).not.toHaveProperty(
      "activeAuthoritySha256",
    );
    expect(await store.getErasurePolicyEvaluationJob(input.requestId)).toMatchObject({
      buildGeneration: 3,
      targetCount: 0,
      attempts: 0,
    });
    claimed = await claimEvaluation(store, BASE + 311);
    await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 312, limit: 10 });
    expect((await store.sealErasurePurgeAuthority(claimed.authorization, {
      nowMs: BASE + 313,
    })).authority?.buildGeneration).toBe(3);
  });

  it("fails closed on a foreign-owner receipt sharing an owned session id", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-receipt-owner";
    const userId = "user-eval-receipt-owner";
    const { session } = await tombstoneAndReconcile(store, tenantId, userId);
    const { input } = await awaitingRequest(store, { tenantId, userId, policy: policy() });
    store.idem.set(JSON.stringify(["foreign-tenant", "foreign-user", session.id, "foreign"]), {
      value: null,
      expiresAt: BASE + 900,
    });
    const claimed = await claimEvaluation(store, BASE + 304);
    await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
    expect((await store.listErasurePurgeTargetEvidence(input.requestId, 1))[0]).toMatchObject({
      idempotencyReceiptCount: 0,
      issueCodes: expect.arrayContaining(["receipt_invalid"]),
    });
    const sealed = await store.sealErasurePurgeAuthority(claimed.authorization, {
      nowMs: BASE + 306,
    });
    expect(sealed.decision.decision).toBe("invalid");
    expect(sealed.authority).toBeUndefined();
  });

  it("never lets a matching usage summary erase a foreign-owner ledger conflict", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-usage-owner";
    const userId = "user-eval-usage-owner";
    await tombstoneAndReconcile(store, tenantId, userId);
    const row = store.usageLedger[0]!;
    if (!row.usageId) throw new Error("expected reconciled usage identity");
    const foreign = { ...row, tenantId: "foreign-tenant", userId: "foreign-user" };
    store.usageLedger[0] = foreign;
    store.billingUsageFacts.set(row.usageId, billingUsageFactFromLedger({
      ...foreign,
      usageId: row.usageId,
    }));
    const { input } = await awaitingRequest(store, { tenantId, userId, policy: policy() });
    const claimed = await claimEvaluation(store, BASE + 304);
    await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
    expect((await store.listErasurePurgeTargetEvidence(input.requestId, 1))[0]).toMatchObject({
      operationalUsageStatus: "missing_or_invalid",
      issueCodes: expect.arrayContaining(["usage_reconciliation_invalid"]),
    });
  });

  it("does not copy foreign reconciliation timestamps or checksums into target evidence", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-reconciliation-owner";
    const userId = "user-eval-reconciliation-owner";
    await tombstoneAndReconcile(store, tenantId, userId);
    const [entry] = [...store.usageReconciliations.entries()];
    expect(entry).toBeDefined();
    const [key, reconciliation] = entry!;
    const foreignVerifiedAtMs = BASE + 900;
    const foreignChecksum = "f".repeat(64);
    store.usageReconciliations.set(key, {
      ...reconciliation,
      tenantId: "foreign-tenant",
      userId: "foreign-user",
      verifiedAtMs: foreignVerifiedAtMs,
      checksum: foreignChecksum,
    });
    const { input } = await awaitingRequest(store, { tenantId, userId, policy: policy() });
    const claimed = await claimEvaluation(store, BASE + 304);
    await store.buildErasurePurgeTargetPage(claimed.authorization, {
      nowMs: BASE + 305,
      limit: 10,
    });
    expect((await store.listErasurePurgeTargetEvidence(input.requestId, 1))[0]).toMatchObject({
      operationalUsageStatus: "missing_or_invalid",
      operationalUsageVerifiedAtMs: BASE + 100,
      operationalUsageChecksum: "0".repeat(64),
      operationalUsageDeadlineMs: BASE + 100,
      issueCodes: expect.arrayContaining(["usage_reconciliation_invalid"]),
    });
  });

  it("fails closed on malformed ready blobs and excludes foreign-owner ready blobs", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-blob-integrity";
    const userId = "user-eval-blob-integrity";
    const { session } = await tombstoneAndReconcile(store, tenantId, userId);
    const malformedBlobId = newId("blob");
    store.blobManifests.set(malformedBlobId, {
      blobId: malformedBlobId,
      tenantId,
      userId,
      sessionId: session.id,
      itemId: newId("item"),
      purpose: "tool_output",
      storageBackend: "memory-v1",
      storageFormat: BLOB_STORAGE_FORMAT,
      storageKey: `objects/${malformedBlobId.slice(5)}`,
      uploadToken: `upload-${malformedBlobId.slice(5)}`,
      state: "ready",
      sizeBytes: 1,
      uploadedAtMs: BASE + 10,
      readyAtMs: BASE + 20,
      deletionGeneration: 0,
      createdAtMs: BASE,
    });
    const foreignBlobId = newId("blob");
    store.blobManifests.set(foreignBlobId, {
      blobId: foreignBlobId,
      tenantId: "foreign-tenant",
      userId: "foreign-user",
      sessionId: session.id,
      itemId: newId("item"),
      purpose: "tool_output",
      storageBackend: "memory-v1",
      storageFormat: BLOB_STORAGE_FORMAT,
      storageKey: `objects/${foreignBlobId.slice(5)}`,
      uploadToken: `upload-${foreignBlobId.slice(5)}`,
      state: "ready",
      sha256: "a".repeat(64),
      sizeBytes: 1,
      uploadedAtMs: BASE + 10,
      readyAtMs: BASE + 20,
      deletionGeneration: 0,
      createdAtMs: BASE,
    });
    const { input } = await awaitingRequest(store, { tenantId, userId, policy: policy() });
    const claimed = await claimEvaluation(store, BASE + 304);
    await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
    expect((await store.listErasurePurgeTargetEvidence(input.requestId, 1))[0]).toMatchObject({
      readyBlobCount: 1,
      issueCodes: expect.arrayContaining(["blob_invalid"]),
    });
    expect((await store.sealErasurePurgeAuthority(claimed.authorization, {
      nowMs: BASE + 306,
    })).decision.decision).toBe("invalid");
  });

  it("re-evaluates a sealed invalid staging target after orphan cleanup completes", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-staging-recovery";
    const userId = "user-eval-staging-recovery";
    const { blobId } = await tombstoneAndReconcile(
      store,
      tenantId,
      userId,
      { stageExpiredBlob: true },
    );
    const { input } = await awaitingRequest(store, { tenantId, userId, policy: policy() });
    let claimed = await claimEvaluation(store, BASE + 304);
    await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
    expect((await store.sealErasurePurgeAuthority(claimed.authorization, {
      nowMs: BASE + 305,
    })).decision.decision).toBe("invalid");
    expect(await store.scheduleAwaitingErasurePolicyEvaluations({
      nowMs: BASE + 306,
      limit: 10,
    })).toBe(0);

    expect(await store.scheduleStaleBlobDeletes({ nowMs: BASE + 306, limit: 10 })).toBe(1);
    const [deleteClaim] = await store.claimBlobDeletes({
      nowMs: BASE + 306,
      limit: 1,
      leaseMs: 100,
      claimToken: "blob-delete-worker-0001",
    });
    expect(deleteClaim?.blobId).toBe(blobId);
    expect(await store.completeBlobDelete(
      deleteClaim!.outboxId,
      deleteClaim!.claimToken!,
      BASE + 307,
    )).toBe(true);
    expect(await store.scheduleAwaitingErasurePolicyEvaluations({
      nowMs: BASE + 308,
      limit: 10,
    })).toBe(1);
    expect(await store.getErasurePolicyEvaluationJob(input.requestId)).toMatchObject({
      buildGeneration: 2,
      targetCount: 0,
    });
    claimed = await claimEvaluation(store, BASE + 308);
    await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 309, limit: 10 });
    const resealed = await store.sealErasurePurgeAuthority(claimed.authorization, {
      nowMs: BASE + 310,
    });
    expect(resealed.decision.decision).toBe("eligible_execution_disabled");
    expect(resealed.authority?.buildGeneration).toBe(2);
  });

  it("rolls back the awaiting transition, audit and first evaluation job together", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-transition-rollback";
    const userId = "user-eval-transition-rollback";
    const requestId = newErasureRequestId();
    await store.requestUserErasure({
      requestId,
      tenantId,
      userId,
      requestedByKeyId: "erasure-admin",
      idempotencyKey: "erase-transition-rollback",
      requestHash: userErasureRequestHash(tenantId, userId),
      atMs: BASE + 300,
    });
    for (const [index, [fromStatus, toStatus]] of ([
      ["gated", "draining"],
      ["draining", "tombstoning"],
      ["tombstoning", "reconciling_usage"],
    ] as const).entries()) {
      const atMs = BASE + 301 + index;
      const claim = (await store.claimErasureJobs({
        nowMs: atMs,
        limit: 1,
        leaseMs: 50,
        claimToken: `transition-worker-${index}`,
      }))[0]!;
      expect(await store.transitionErasureJob(jobAuthorization(claim), {
        fromStatus,
        toStatus,
        atMs,
        availableAtMs: atMs,
      })).toBe(true);
    }
    const claim = (await store.claimErasureJobs({
      nowMs: BASE + 304,
      limit: 1,
      leaseMs: 50,
      claimToken: "transition-worker-final",
    }))[0]!;
    const jobs = store.erasurePolicyEvaluationJobs;
    Object.defineProperty(jobs, "set", {
      configurable: true,
      value: () => { throw new Error("injected evaluation job insert failure"); },
    });
    await expect(store.transitionErasureJob(jobAuthorization(claim), {
      fromStatus: "reconciling_usage",
      toStatus: "awaiting_purge_policy",
      atMs: BASE + 304,
    })).rejects.toThrow("injected evaluation job insert failure");
    Reflect.deleteProperty(jobs, "set");

    expect(store.erasureRequests.get(requestId)).toMatchObject({
      status: "reconciling_usage",
      claimToken: claim.claimToken,
      attempts: claim.attempts,
    });
    expect(store.erasureAuditEvents.get(requestId)).toHaveLength(4);
    expect(store.erasurePolicyEvaluationJobs.has(requestId)).toBe(false);
  });

  it("rolls back decision, control, authority and seal when publication fails", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-rollback";
    const userId = "user-eval-rollback";
    await tombstoneAndReconcile(store, tenantId, userId);
    const { input } = await awaitingRequest(store, { tenantId, userId, policy: policy() });
    const claimed = await claimEvaluation(store, BASE + 304);
    await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });

    const decisions = store.erasurePolicyEvaluationDecisions;
    const originalSet = decisions.set.bind(decisions);
    let fail = true;
    Object.defineProperty(decisions, "set", {
      configurable: true,
      value: (key: string, value: unknown) => {
        if (fail) {
          fail = false;
          throw new Error("injected decision publication failure");
        }
        return originalSet(key, value as never);
      },
    });
    await expect(store.sealErasurePurgeAuthority(claimed.authorization, {
      nowMs: BASE + 306,
    })).rejects.toThrow("injected decision publication failure");
    expect(store.erasurePolicyEvaluationDecisions.get(input.requestId)).toBeUndefined();
    expect(store.erasurePurgeAuthorityControls.get(input.requestId)).toBeUndefined();
    expect(store.erasurePurgeAuthorities.get(input.requestId)).toBeUndefined();
    const durableJob = await store.getErasurePolicyEvaluationJob(input.requestId);
    expect(durableJob).toMatchObject({
      claimToken: claimed.claim.claimToken,
      attempts: claimed.claim.claimAttempt,
    });
    expect(durableJob).not.toHaveProperty("sealedAtMs");
  });

  it("cannot publish a stale seal after a concurrent evidence-generation retry", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-eval-seal-race";
    const userId = "user-eval-seal-race";
    await tombstoneAndReconcile(store, tenantId, userId);
    const { input } = await awaitingRequest(store, { tenantId, userId, policy: policy() });
    const claimed = await claimEvaluation(store, BASE + 304);
    await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });

    const originalValidatedRead = store.getValidatedErasurePurgeAuthority.bind(store);
    let releaseRead!: () => void;
    const readMayFinish = new Promise<void>((resolve) => { releaseRead = resolve; });
    let readStarted!: () => void;
    const readDidStart = new Promise<void>((resolve) => { readStarted = resolve; });
    Object.defineProperty(store, "getValidatedErasurePurgeAuthority", {
      configurable: true,
      value: async (requestId: string) => {
        readStarted();
        await readMayFinish;
        return originalValidatedRead(requestId);
      },
    });
    const sealing = store.sealErasurePurgeAuthority(claimed.authorization, { nowMs: BASE + 306 });
    await readDidStart;
    expect(await store.retryErasurePolicyEvaluation(claimed.authorization, {
      failedAtMs: BASE + 306,
      availableAtMs: BASE + 307,
      errorCode: "evidence_changed",
    })).toBe(true);
    releaseRead();
    await expect(sealing).rejects.toThrow("stale erasure policy evaluation authority");
    Reflect.deleteProperty(store, "getValidatedErasurePurgeAuthority");
    expect(await store.getErasurePolicyEvaluationJob(input.requestId)).toMatchObject({
      buildGeneration: 2,
      targetCount: 0,
    });
    expect(store.erasurePolicyEvaluationDecisions.get(input.requestId)).toBeUndefined();
    expect(store.erasurePurgeAuthorities.get(input.requestId)).toBeUndefined();
  });

  it("isolates poisoned scheduler and claim candidates without starving healthy work", async () => {
    const store = new MemorySessionStore();
    const requests: string[] = [];
    for (const suffix of ["a", "b"]) {
      const tenantId = `tenant-eval-poison-${suffix}`;
      const userId = `user-eval-poison-${suffix}`;
      await tombstoneAndReconcile(store, tenantId, userId);
      const { input } = await awaitingRequest(store, {
        tenantId,
        userId,
        policy: policy({ userErasureGraceMs: 100 }),
      });
      requests.push(input.requestId);
      const claimed = await claimEvaluation(store, BASE + 304);
      expect(claimed.claim.requestId).toBe(input.requestId);
      await store.buildErasurePurgeTargetPage(claimed.authorization, { nowMs: BASE + 305, limit: 10 });
      expect((await store.sealErasurePurgeAuthority(claimed.authorization, {
        nowMs: BASE + 305,
      })).decision.decision).toBe("waiting");
    }
    const [poisonRequestId, healthyRequestId] = [...requests].sort() as [string, string];
    const poisonJob = store.erasurePolicyEvaluationJobs.get(poisonRequestId)!;
    store.erasurePolicyEvaluationJobs.set(poisonRequestId, {
      ...poisonJob,
      targetRootSha256: "not-a-sha256",
    });
    await expect(store.scheduleAwaitingErasurePolicyEvaluations({
      nowMs: BASE + 400,
      limit: 10,
    })).rejects.toThrow("erasure policy evaluation job is invalid");
    expect(await store.getErasurePolicyEvaluationJob(healthyRequestId)).toMatchObject({
      buildGeneration: 2,
      availableAtMs: BASE + 400,
    });

    const thirdTenant = "tenant-eval-claim-poison";
    const thirdUser = "user-eval-claim-poison";
    await tombstoneAndReconcile(store, thirdTenant, thirdUser);
    const third = await awaitingRequest(store, {
      tenantId: thirdTenant,
      userId: thirdUser,
      policy: policy(),
    });
    const thirdJob = store.erasurePolicyEvaluationJobs.get(third.input.requestId)!;
    store.erasurePolicyEvaluationJobs.set(third.input.requestId, {
      ...thirdJob,
      targetRootSha256: "not-a-sha256",
    });
    const [healthyClaim] = await store.claimErasurePolicyEvaluations({
      nowMs: BASE + 400,
      limit: 1,
      leaseMs: 100,
      claimToken: "evaluation-healthy-after-poison",
    });
    expect(healthyClaim?.requestId).toBe(healthyRequestId);
  });
});
