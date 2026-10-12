import { describe, expect, it } from "vitest";
import {
  TENANT_TELEMETRY_DISPOSITION_CONTROL_SCOPE,
  TENANT_TELEMETRY_DISPOSITION_CONTROL_SINGLETON_ID,
  TENANT_TELEMETRY_DISPOSITION_JOB_SCOPE,
  TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
  TENANT_TELEMETRY_DISPOSITION_REPLAY_FENCE_SCOPE,
  tenantTelemetryDispositionActivationEvidenceSha256,
  tenantTelemetryDispositionInventoryTargetRootSha256,
  tenantTelemetryDispositionPlanTargetSha256,
  tenantTelemetryDispositionReplayFenceSha256,
  validateTenantTelemetrySameKeyTombstoneAck,
  validateTenantTelemetryDispositionControl,
  validateTenantTelemetryDispositionClaim,
  validateTenantTelemetryDispositionEvidence,
  validateTenantTelemetryDispositionExternalEvent,
  validateTenantTelemetryDispositionJobRecord,
  validateTenantTelemetryDispositionReplayFence,
  type ActiveTenantTelemetryDispositionControlBody,
  type TenantTelemetryDispositionJobRecord,
  type TenantTelemetryDispositionReplayFenceBody,
} from "../src/tenant-telemetry-disposition.js";
import {
  tenantPurgePlanTargetRootSha256,
  tenantPurgePlanTargetSha256,
} from "../src/tenant-purge-plan.js";
import {
  assertTenantTelemetryDispositionEventChain,
  buildTenantTelemetryExternalAuthorizationProof,
  buildTenantTelemetryExternalTombstoneProof,
  emptyTenantTelemetryDispositionHead,
  headAfterTenantTelemetryDispositionEvent,
} from "../src/tenant-telemetry-disposition-adapter/common.js";
import {
  decodeTenantTelemetryDispositionEnvelope,
  encodeTenantTelemetryDispositionEnvelope,
} from "../src/tenant-telemetry-disposition-adapter/codec.js";
import {
  buildTenantTelemetryDispositionStoredEvent,
  canonicalTenantTelemetryDispositionStoredEvent,
  parseCanonicalTenantTelemetryDispositionStoredEvent,
} from "../src/tenant-telemetry-disposition-adapter/serialization.js";
import { dispositionDigest, dispositionEvidence, tombstoneAck } from "./tenant-telemetry-disposition.fixture.js";

const identity = {
  adapterProtocol: "fixture-disposition-journal-v1",
  journalNamespaceSha256: dispositionDigest("namespace"),
  journalTargetSha256: dispositionDigest("journal-target"),
  failureDomainSha256: dispositionDigest("failure-domain"),
  logicalDatabaseNamespaceSha256: dispositionDigest("logical-database"),
};

describe("tenant telemetry disposition protocol", () => {
  it("shares the exact T3d target/root grammar and rejects duplicate or mixed-domain artifacts", () => {
    const first = dispositionEvidence(1);
    const second = dispositionEvidence(3);
    const target = (evidence: typeof first) => ({
      domain: evidence.domain,
      targetSha256: evidence.targetSha256,
      artifactIdSha256: evidence.artifactIdSha256,
      artifactGeneration: evidence.artifactGeneration,
      inventoryReceiptSha256: evidence.inventoryReceiptSha256,
      writeAckReceiptSha256: evidence.writeAckReceiptSha256,
    });
    const firstTarget = target(first);
    const secondTarget = target(second);
    expect(tenantTelemetryDispositionPlanTargetSha256(firstTarget)).toBe(
      tenantPurgePlanTargetSha256("logs", [
        first.targetSha256,
        first.artifactIdSha256,
        first.artifactGeneration,
        first.inventoryReceiptSha256,
        first.writeAckReceiptSha256,
      ]),
    );
    const root = tenantTelemetryDispositionInventoryTargetRootSha256(
      "logs", [firstTarget, secondTarget],
    );
    expect(root).toBe(tenantTelemetryDispositionInventoryTargetRootSha256(
      "logs", [secondTarget, firstTarget],
    ));
    expect(root).toBe(tenantPurgePlanTargetRootSha256("logs", [
      tenantTelemetryDispositionPlanTargetSha256(firstTarget),
      tenantTelemetryDispositionPlanTargetSha256(secondTarget),
    ]));
    expect(() => tenantTelemetryDispositionInventoryTargetRootSha256(
      "logs", [firstTarget, firstTarget],
    )).toThrow("duplicated");
    expect(() => tenantTelemetryDispositionInventoryTargetRootSha256(
      "logs", [target(dispositionEvidence(2))],
    )).toThrow("domain does not match");
  });

  it("uses strict content-free evidence and rejects unknown or partial application fields", () => {
    const evidence = dispositionEvidence(1);
    expect(() => validateTenantTelemetryDispositionEvidence(evidence)).not.toThrow();
    expect(JSON.stringify(evidence)).not.toContain("tenant-");
    expect(() => validateTenantTelemetryDispositionEvidence({
      ...evidence,
      tenantId: "must-not-cross-the-authority-boundary",
    } as typeof evidence)).toThrow("unknown or missing fields");
    expect(() => validateTenantTelemetryDispositionEvidence({
      ...evidence,
      applicationCoverageEvidenceSha256: null,
    })).toThrow("application evidence is incomplete");
  });

  it("enforces claim/lease phase semantics and forbids blocking after external authorization", () => {
    const evidence = dispositionEvidence(9);
    const base = {
      scope: TENANT_TELEMETRY_DISPOSITION_JOB_SCOPE,
      protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
      tenantId: "tenant-one",
      requestId: "request-one",
      ...evidence,
      attempts: 0,
      createdAtDbMs: 100,
      updatedAtDbMs: 100,
    };
    const queued = {
      ...base,
      phase: "queued" as const,
      availableAtDbMs: 100,
    };
    expect(() => validateTenantTelemetryDispositionJobRecord(queued)).not.toThrow();
    expect(() => validateTenantTelemetryDispositionJobRecord({
      ...queued,
      claimToken: "claim-one",
    } as TenantTelemetryDispositionJobRecord)).toThrow("claim is incomplete");
    expect(() => validateTenantTelemetryDispositionJobRecord({
      ...queued,
      externalAuthorizationProof: buildTenantTelemetryExternalAuthorizationProof(
        identity, evidence, emptyTenantTelemetryDispositionHead(identity),
      ),
    })).toThrow("queued tenant telemetry disposition job has external authorization");
    const proof = buildTenantTelemetryExternalAuthorizationProof(
      identity, evidence, emptyTenantTelemetryDispositionHead(identity),
    );
    const authorized = {
      ...base,
      phase: "authorized" as const,
      attempts: 1,
      availableAtDbMs: 110,
      updatedAtDbMs: 110,
      externalAuthorizationProof: proof,
    };
    expect(() => validateTenantTelemetryDispositionJobRecord(authorized)).not.toThrow();
    expect(() => validateTenantTelemetryDispositionClaim({
      tenantId: base.tenantId,
      requestId: base.requestId,
      ...evidence,
      phase: "authorized",
      claimAttempt: 2,
      claimToken: "claim-two",
      leaseUntilDbMs: 130,
      externalAuthorizationProof: proof,
    })).not.toThrow();
    expect(() => validateTenantTelemetryDispositionJobRecord({
      ...base,
      phase: "blocked",
      blockedAtDbMs: 110,
      blockedReasonCode: "integrity_conflict",
      updatedAtDbMs: 110,
      externalAuthorizationProof: proof,
    } as never)).toThrow("unknown or missing fields");
  });

  it("validates generation-zero dormancy and content-free write-once activation evidence", () => {
    expect(() => validateTenantTelemetryDispositionControl({
      singletonId: TENANT_TELEMETRY_DISPOSITION_CONTROL_SINGLETON_ID,
      state: "inactive",
      controlGeneration: 0,
    })).not.toThrow();
    const body: ActiveTenantTelemetryDispositionControlBody = {
      singletonId: TENANT_TELEMETRY_DISPOSITION_CONTROL_SINGLETON_ID,
      state: "active",
      controlGeneration: 1,
      scope: TENANT_TELEMETRY_DISPOSITION_CONTROL_SCOPE,
      protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
      lifecycleControlGeneration: 1,
      lifecycleTargetRootSha256: dispositionDigest("lifecycle-target-root"),
      ...identity,
      activatedAtDbMs: 1_700_000_000_000,
    };
    const control = {
      ...body,
      activationEvidenceSha256: tenantTelemetryDispositionActivationEvidenceSha256(body),
    };
    expect(() => validateTenantTelemetryDispositionControl(control)).not.toThrow();
    expect(JSON.stringify(control)).not.toMatch(/tenantId|requestId|ownerRef|https?:\/\//);
  });

  it("binds authorization before tombstone and produces a strict two-event chain", () => {
    const evidence = dispositionEvidence(2);
    const genesis = emptyTenantTelemetryDispositionHead(identity);
    const authorization = buildTenantTelemetryExternalAuthorizationProof(
      identity,
      evidence,
      genesis,
    );
    const authorizedEvent = { eventType: "delete_authorized" as const, result: authorization };
    const ack = tombstoneAck(authorization);
    const terminal = buildTenantTelemetryExternalTombstoneProof(
      identity,
      authorization,
      ack,
      headAfterTenantTelemetryDispositionEvent(identity, authorizedEvent),
    );
    const terminalEvent = { eventType: "delete_tombstoned" as const, result: terminal };
    expect(() => validateTenantTelemetryDispositionExternalEvent(authorizedEvent)).not.toThrow();
    expect(() => validateTenantTelemetryDispositionExternalEvent(terminalEvent)).not.toThrow();
    expect(() => assertTenantTelemetryDispositionEventChain(
      identity,
      [authorizedEvent, terminalEvent],
    )).not.toThrow();
    expect(() => assertTenantTelemetryDispositionEventChain(
      identity,
      [terminalEvent],
    )).toThrow("corrupt");
    expect(() => validateTenantTelemetrySameKeyTombstoneAck({
      ...ack,
      replayed: true,
    } as typeof ack)).toThrow("unknown or missing fields");
    expect(() => validateTenantTelemetrySameKeyTombstoneAck({
      ...ack,
      outcome: "already_absent_fenced",
    } as never)).toThrow("outcome is invalid");
  });

  it("round-trips canonical stored events and rejects envelope corruption/kind confusion", () => {
    const evidence = dispositionEvidence(3);
    const authorization = buildTenantTelemetryExternalAuthorizationProof(
      identity,
      evidence,
      emptyTenantTelemetryDispositionHead(identity),
    );
    const event = { eventType: "delete_authorized" as const, result: authorization };
    const stored = buildTenantTelemetryDispositionStoredEvent(identity, event);
    const canonical = canonicalTenantTelemetryDispositionStoredEvent(stored);
    expect(parseCanonicalTenantTelemetryDispositionStoredEvent(canonical)).toEqual(stored);
    const encoded = encodeTenantTelemetryDispositionEnvelope("event", canonical);
    expect(decodeTenantTelemetryDispositionEnvelope("event", encoded)).toBe(canonical);
    const corrupt = Buffer.from(encoded);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    expect(() => decodeTenantTelemetryDispositionEnvelope("event", corrupt)).toThrow("checksum");
    expect(() => decodeTenantTelemetryDispositionEnvelope("head", encoded)).toThrow("kind");
    expect(() => parseCanonicalTenantTelemetryDispositionStoredEvent(
      JSON.stringify(stored),
    )).toThrow("not canonical");
  });

  it("makes the external terminal event sufficient to rebuild an exact permanent fence", () => {
    const evidence = dispositionEvidence(4);
    const authorization = buildTenantTelemetryExternalAuthorizationProof(
      identity,
      evidence,
      emptyTenantTelemetryDispositionHead(identity),
    );
    const authorizedEvent = { eventType: "delete_authorized" as const, result: authorization };
    const terminal = buildTenantTelemetryExternalTombstoneProof(
      identity,
      authorization,
      tombstoneAck(authorization),
      headAfterTenantTelemetryDispositionEvent(identity, authorizedEvent),
    );
    const body: TenantTelemetryDispositionReplayFenceBody = {
      scope: TENANT_TELEMETRY_DISPOSITION_REPLAY_FENCE_SCOPE,
      protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
      domain: terminal.authorization.domain,
      targetSha256: terminal.authorization.targetSha256,
      artifactIdSha256: terminal.authorization.artifactIdSha256,
      artifactGeneration: terminal.authorization.artifactGeneration,
      dispositionOperationSha256: terminal.authorization.dispositionOperationSha256,
      authorizationReceiptSha256: terminal.authorization.authorizationReceiptSha256,
      tombstoneReceiptSha256: terminal.tombstoneAck.receiptSha256,
      terminalReceiptSha256: terminal.terminalReceiptSha256,
      journalTargetSha256: terminal.journalTargetSha256,
      terminalJournalSequence: terminal.journalSequence,
      terminalJournalEventRootSha256: terminal.journalEventRootSha256,
      sealedJournalSequence: terminal.journalSequence,
      sealedJournalEventRootSha256: terminal.journalEventRootSha256,
      restoreRunSha256: dispositionDigest("restore-run"),
      runtimeEpochSha256: dispositionDigest("runtime-epoch"),
    };
    const fence = { ...body, receiptSha256: tenantTelemetryDispositionReplayFenceSha256(body) };
    expect(() => validateTenantTelemetryDispositionReplayFence(fence)).not.toThrow();
    expect(fence).toMatchObject({
      targetSha256: evidence.targetSha256,
      artifactIdSha256: evidence.artifactIdSha256,
      artifactGeneration: evidence.artifactGeneration,
    });
    expect(JSON.stringify(fence)).not.toMatch(/tenantId|requestId|ownerRef|https?:\/\//);
  });
});
