import { describe, expect, it } from "vitest";
import {
  LEGACY_TOMBSTONE_CUTOVER_ID,
  legacyTombstoneClaimTokenSha256,
  legacyTombstoneCompensationAuthorizationMatches,
  legacyTombstoneCompensationClaimFromRecord,
  legacyTombstoneCompensationJobIdForSession,
  legacyTombstoneSuccessEvidenceSha256,
  legacyTombstoneUnsafeJobEnvelopeEvidenceSha256,
  newErasureRequestId,
  newLegacyTombstoneCompensationJobId,
  validateActivateLegacyTombstoneCutoverInput,
  validateClaimLegacyTombstoneCompensationsOptions,
  validateLegacyTombstoneCompensationAudit,
  validateLegacyTombstoneCompensationJobRecord,
  validateScheduleLegacyTombstoneCandidatesOptions,
  type LegacyTombstoneCompensationJobRecord,
} from "../src/index.js";
import { newId } from "./conformance.js";

function pendingJob(): LegacyTombstoneCompensationJobRecord {
  return {
    jobId: newLegacyTombstoneCompensationJobId(),
    tenantId: "tenant-legacy-validator",
    userId: "u_legacy_validator",
    sessionId: newId("sess"),
    sourceKind: "erasure_claim",
    sourceRequestId: newErasureRequestId(),
    sourceSubjectGeneration: 1,
    sourceClaimAttempt: 2,
    sourceClaimTokenSha256: legacyTombstoneClaimTokenSha256("source-token"),
    cutoverGeneration: 1,
    legacyDeletedAtMs: 100,
    status: "pending",
    createdAtMs: 200,
    updatedAtMs: 200,
    availableAtMs: 200,
    attempts: 0,
  };
}

describe("legacy tombstone contracts", () => {
  it("requires one explicit cutover identity and a bounded trusted scheduler", () => {
    expect(() => validateActivateLegacyTombstoneCutoverInput({
      cutoverId: LEGACY_TOMBSTONE_CUTOVER_ID,
      expectedGeneration: 0,
      actorKeyId: "maintenance-v1",
      atMs: 100,
    })).not.toThrow();
    expect(() => validateActivateLegacyTombstoneCutoverInput({
      cutoverId: LEGACY_TOMBSTONE_CUTOVER_ID,
      expectedGeneration: 1 as 0,
      actorKeyId: "maintenance-v1",
      atMs: 100,
    })).toThrow("generation 0");
    expect(() => validateScheduleLegacyTombstoneCandidatesOptions({
      cutoverGeneration: 1,
      actorKeyId: "maintenance-v1",
      nowMs: 100,
      limit: 101,
    })).toThrow("between 1 and 100");
  });

  it("derives a stable canonical maintenance job id per session", () => {
    const sessionId = newId("sess");
    const first = legacyTombstoneCompensationJobIdForSession(sessionId);
    expect(first).toBe(legacyTombstoneCompensationJobIdForSession(sessionId));
    expect(first).toMatch(/^ltc_[0-9a-f-]{36}$/);
    expect(first).not.toBe(legacyTombstoneCompensationJobIdForSession(newId("sess")));
  });

  it("validates erasure-claim and maintenance sources without inventing the other identity", () => {
    const erasure = pendingJob();
    expect(() => validateLegacyTombstoneCompensationJobRecord(erasure)).not.toThrow();

    const maintenance: LegacyTombstoneCompensationJobRecord = {
      ...erasure,
      sourceKind: "maintenance",
      maintenanceActorKeyId: "maintenance-v1",
      sourceRequestId: undefined,
      sourceSubjectGeneration: undefined,
      sourceClaimAttempt: undefined,
      sourceClaimTokenSha256: undefined,
    };
    expect(() => validateLegacyTombstoneCompensationJobRecord(maintenance)).not.toThrow();
    expect(() => validateLegacyTombstoneCompensationJobRecord({
      ...maintenance,
      sourceRequestId: newErasureRequestId(),
    } as unknown as LegacyTombstoneCompensationJobRecord)).toThrow("has erasure claim identity");
  });

  it("enforces mutually exclusive pending, completed and terminal job envelopes", () => {
    const pending = pendingJob();
    expect(() => validateLegacyTombstoneCompensationJobRecord({
      ...pending,
      completedAtMs: 300,
    })).toThrow("terminal fields");

    const completed: LegacyTombstoneCompensationJobRecord = {
      ...pending,
      status: "completed",
      updatedAtMs: 300,
      availableAtMs: undefined,
      completedAtMs: 300,
      completedEventSeq: 2,
      completedClaimAttempt: 1,
      completedClaimTokenSha256: legacyTombstoneClaimTokenSha256("worker-a"),
    };
    expect(() => validateLegacyTombstoneCompensationJobRecord(completed)).not.toThrow();
    expect(() => validateLegacyTombstoneCompensationJobRecord({
      ...completed,
      availableAtMs: 300,
    })).toThrow("invalid terminal fields");

    expect(() => validateLegacyTombstoneCompensationJobRecord({
      ...pending,
      status: "terminal_incident",
      availableAtMs: undefined,
      terminalAtMs: 300,
      terminalReasonCode: "proof_conflict",
      terminalEvidenceSha256: "a".repeat(64),
    })).not.toThrow();
  });

  it("matches a live lease by owner, token and monotonic attempt to prevent ABA", () => {
    const record: LegacyTombstoneCompensationJobRecord = {
      ...pendingJob(),
      attempts: 2,
      claimToken: "reused-token",
      leaseUntilMs: 400,
    };
    const authorization = {
      jobId: record.jobId,
      tenantId: record.tenantId,
      userId: record.userId,
      sessionId: record.sessionId,
      cutoverGeneration: 1 as const,
      claimToken: "reused-token",
      claimAttempt: 2,
    };
    expect(legacyTombstoneCompensationAuthorizationMatches(record, authorization, 399)).toBe(true);
    expect(legacyTombstoneCompensationAuthorizationMatches(
      record,
      { ...authorization, claimAttempt: 1 },
      399,
    )).toBe(false);
    expect(legacyTombstoneCompensationAuthorizationMatches(record, authorization, 400)).toBe(false);
    expect(legacyTombstoneCompensationClaimFromRecord(record)).toMatchObject({
      attempts: 2,
      claimAttempt: 2,
      claimToken: "reused-token",
    });
  });

  it("rejects invalid claim bounds and overflow", () => {
    expect(() => validateClaimLegacyTombstoneCompensationsOptions({
      nowMs: 100,
      limit: 0,
      leaseMs: 10,
      claimToken: "worker",
    })).toThrow("between 1 and 100");
    expect(() => validateClaimLegacyTombstoneCompensationsOptions({
      nowMs: Number.MAX_SAFE_INTEGER,
      limit: 1,
      leaseMs: 1,
      claimToken: "worker",
    })).toThrow("deadline");
  });

  it("hashes exact unsafe envelopes and validates content-free success audit", () => {
    const job = pendingJob();
    const envelope = {
      locatorJobId: job.jobId,
      jobId: job.jobId,
      tenantId: job.tenantId,
      userId: job.userId,
      sessionId: job.sessionId,
      sourceRequestId: job.sourceKind === "erasure_claim" ? job.sourceRequestId : null,
      sourceKind: job.sourceKind,
      rawSourceSubjectGeneration: "1",
      rawSourceClaimAttempt: "2",
      sourceClaimTokenSha256: job.sourceKind === "erasure_claim" ? job.sourceClaimTokenSha256 : null,
      maintenanceActorKeyId: null,
      rawCutoverGeneration: "1",
      rawLegacyDeletedAtMs: "100",
      status: "pending",
      rawCreatedAtMs: "200",
      rawUpdatedAtMs: "200",
      rawAvailableAtMs: "200",
      rawAttempts: "9007199254740993",
      claimToken: null,
      rawLeaseUntilMs: null,
    };
    const hash = legacyTombstoneUnsafeJobEnvelopeEvidenceSha256(envelope);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(legacyTombstoneUnsafeJobEnvelopeEvidenceSha256({
      ...envelope,
      rawAttempts: "9007199254740994",
    })).not.toBe(hash);

    const emittedAtMs = 300;
    const audit = {
      auditId: 1,
      jobId: job.jobId,
      type: "legacy_tombstone/compensated" as const,
      sessionId: job.sessionId,
      cutoverGeneration: 1 as const,
      deletionGeneration: 1 as const,
      eventSeq: 2,
      claimAttempt: 1,
      evidenceSha256: legacyTombstoneSuccessEvidenceSha256({
        jobId: job.jobId,
        tenantId: job.tenantId,
        userId: job.userId,
        sessionId: job.sessionId,
        cutoverGeneration: 1,
        legacyDeletedAtMs: job.legacyDeletedAtMs,
        deletionGeneration: 1,
        eventSeq: 2,
        claimAttempt: 1,
        emittedAtMs,
      }),
      emittedAtMs,
    };
    expect(() => validateLegacyTombstoneCompensationAudit(audit)).not.toThrow();
    expect(Object.keys(audit)).not.toContain("tenantId");
    expect(Object.keys(audit)).not.toContain("userId");
    expect(Object.keys(audit)).not.toContain("payload");
  });
});
