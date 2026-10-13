import { createHash } from "node:crypto";
import type { BillingUsageFact, UsageReconciliationRecord } from "./types.js";
import type { RetentionPolicyVersionRecord } from "./retention-policy.js";
import { ORDINARY_SESSION_DELETE_GRACE_MS, ordinarySessionDeleteGraceSeal,
  type OrdinarySessionDeleteGraceEvidence } from "./session-delete-grace.js";
import { isUsageId, summarizeBillingUsageFacts, usageReconciliationSummariesEqual } from "./usage-lifecycle.js";

export interface OrdinarySessionUsageRetentionCandidate {
  tenantId: string; userId: string; sessionId: string; deletionGeneration: number;
}
export interface ExecuteOrdinarySessionUsageRetentionInput extends OrdinarySessionUsageRetentionCandidate {
  expectedChecksum: string; enabled: true;
}
export interface OrdinarySessionUsageRetentionSource {
  schemaVersion: 2;
  originSha256: string;
  policyVersion: string | null;
  policySha256: string | null;
}
/** Operational rows only. Reconciliation, session/event content and backups still retain identity. */
export interface OrdinarySessionUsageRetentionReceipt {
  schemaVersion: 1;
  sourceSha256: string;
  sealSha256: string;
  deletionPolicySha256: string;
  currentPolicySha256: string;
  currentPolicyVersion: string;
  deadlineDbMs: number;
  executedAtDbMs: number;
  checksum: string;
  facts: { usageId: string; factSha256: string }[];
  allDomainsComplete: false;
  contentPurgeExecuted: false;
}
export interface OrdinarySessionUsageRetentionStore {
  listOrdinarySessionUsageRetentionCandidates(input: { afterSessionId?: string; limit: number }):
    Promise<OrdinarySessionUsageRetentionCandidate[]>;
  executeOrdinarySessionUsageRetention(input: ExecuteOrdinarySessionUsageRetentionInput):
    Promise<OrdinarySessionUsageRetentionReceipt | null>;
}
export const ORDINARY_USAGE_RETENTION_MAX_FACTS = 10_000;
export interface PriorRetainedBillingFactProof {
  schemaVersion: 1;
  facts: { usageId: string; factSha256: string }[];
  evidenceSha256: string;
}
export interface PriorRetainedBillingProofIdentity {
  tenantId: string; requestId: string; subjectGeneration: number; planBuildGeneration: number;
  executionGeneration: number; databasePurgeGeneration: number; preDeleteReceiptSha256: string;
  localPhysicalAckReceiptSha256: string;
}
export function priorRetainedBillingFactProofSha256(identity: PriorRetainedBillingProofIdentity,
  facts: PriorRetainedBillingFactProof["facts"]): string {
  if (!Array.isArray(facts)) throw new Error("prior retained billing bridge fact set invalid");
  let previous = "";
  for (const fact of facts) {
    if (Object.keys(fact).sort().join(",") !== "factSha256,usageId" || !isUsageId(fact.usageId)
      || fact.usageId <= previous || !/^[a-f0-9]{64}$/.test(fact.factSha256)) throw new Error("prior retained billing bridge fact set invalid");
    previous = fact.usageId;
  }
  return hash(["ordinary-usage-to-t3f-billing-bridge-v1", identity.tenantId, identity.requestId,
    identity.subjectGeneration, identity.planBuildGeneration, identity.executionGeneration,
    identity.databasePurgeGeneration, identity.preDeleteReceiptSha256, identity.localPhysicalAckReceiptSha256,
    facts.map((v) => [v.usageId, v.factSha256])]);
}
export function assertPriorRetainedBillingFactProof(identity: PriorRetainedBillingProofIdentity,
  proof: PriorRetainedBillingFactProof): void {
  if (Object.keys(proof).sort().join(",") !== "evidenceSha256,facts,schemaVersion" || proof.schemaVersion !== 1
    || proof.evidenceSha256 !== priorRetainedBillingFactProofSha256(identity, proof.facts)) throw new Error("prior retained billing bridge changed");
}
export function subtractPriorRetainedBillingFacts(tenantId: string, facts: BillingUsageFact[],
  prior: PriorRetainedBillingFactProof["facts"]): BillingUsageFact[] {
  const byId = new Map(facts.map((v) => [v.usageId, v]));
  if (byId.size !== facts.length) throw new Error("retained billing facts have duplicate identities");
  const ids = new Set<string>();
  for (const identity of prior) {
    const fact = byId.get(identity.usageId);
    if (ids.has(identity.usageId) || !fact || fact.tenantId !== tenantId || fact.factSha256 !== identity.factSha256) {
      throw new Error("prior retained billing bridge fact missing or conflicting");
    }
    ids.add(identity.usageId);
  }
  return facts.filter((v) => !ids.has(v.usageId));
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function ordinaryUsageRetentionSourceSha256(
  owner: OrdinarySessionUsageRetentionCandidate, source: OrdinarySessionUsageRetentionSource,
): string {
  if (source.schemaVersion !== 2 || !/^[a-f0-9]{64}$/.test(source.originSha256)
    || (source.policyVersion === null) !== (source.policySha256 === null)
    || (source.policySha256 !== null && !/^[a-f0-9]{64}$/.test(source.policySha256))
    || (source.policyVersion !== null && (typeof source.policyVersion !== "string" || !source.policyVersion || source.policyVersion.length > 128))
    || Object.keys(source).sort().join(",") !== "originSha256,policySha256,policyVersion,schemaVersion") {
    throw new Error("ordinary usage retention source is invalid");
  }
  return hash(["ordinary-session-usage-retention-source-v2", owner.tenantId, owner.userId,
    owner.sessionId, owner.deletionGeneration, source.schemaVersion, source.originSha256,
    source.policyVersion, source.policySha256]);
}
export function ordinaryUsageRetentionReceiptSha256(receipt: OrdinarySessionUsageRetentionReceipt): string {
  if (Object.keys(receipt).sort().join(",") !== "allDomainsComplete,checksum,contentPurgeExecuted,currentPolicySha256,currentPolicyVersion,deadlineDbMs,deletionPolicySha256,executedAtDbMs,facts,schemaVersion,sealSha256,sourceSha256"
    || receipt.schemaVersion !== 1 || receipt.allDomainsComplete !== false || receipt.contentPurgeExecuted !== false
    || ![receipt.sourceSha256, receipt.sealSha256, receipt.deletionPolicySha256,
      receipt.currentPolicySha256, receipt.checksum].every((v) => /^[a-f0-9]{64}$/.test(v))
    || !Number.isSafeInteger(receipt.deadlineDbMs) || receipt.deadlineDbMs < 0
    || !Number.isSafeInteger(receipt.executedAtDbMs) || receipt.executedAtDbMs < receipt.deadlineDbMs
    || typeof receipt.currentPolicyVersion !== "string" || !receipt.currentPolicyVersion || receipt.currentPolicyVersion.length > 128
    || !Array.isArray(receipt.facts) || receipt.facts.length > ORDINARY_USAGE_RETENTION_MAX_FACTS) {
    throw new Error("ordinary usage retention receipt is invalid");
  }
  let previous = "";
  for (const fact of receipt.facts) {
    if (Object.keys(fact).sort().join(",") !== "factSha256,usageId"
      || !isUsageId(fact.usageId) || fact.usageId <= previous
      || !/^[a-f0-9]{64}$/.test(fact.factSha256)) throw new Error("ordinary usage retention fact set is invalid");
    previous = fact.usageId;
  }
  return hash(["ordinary-session-usage-retention-receipt-v1", receipt.schemaVersion,
    receipt.sourceSha256, receipt.sealSha256, receipt.deletionPolicySha256, receipt.currentPolicySha256, receipt.currentPolicyVersion,
    receipt.deadlineDbMs, receipt.executedAtDbMs, receipt.checksum,
    receipt.facts.map((v) => [v.usageId, v.factSha256]), false, false]);
}
export function ordinaryUsageRetentionDeadline(
  grace: OrdinarySessionDeleteGraceEvidence, deletion: RetentionPolicyVersionRecord,
  current: RetentionPolicyVersionRecord,
): number | null {
  if (grace.sealObservedDbMs === undefined || grace.graceFloorDbMs === undefined || grace.sealSha256 === undefined) return null;
  const seal = ordinarySessionDeleteGraceSeal(grace.originSha256, grace.originObservedDbMs, grace.sealObservedDbMs);
  if (seal.sealSha256 !== grace.sealSha256 || seal.graceFloorDbMs !== grace.graceFloorDbMs) {
    throw new Error("ordinary usage retention seal is invalid");
  }
  const a = deletion.policy.operationalUsageRetentionMs;
  const b = current.policy.operationalUsageRetentionMs;
  if (a === null || b === null) return null;
  const deadline = grace.sealObservedDbMs + 1 + Math.max(ORDINARY_SESSION_DELETE_GRACE_MS, a, b);
  if (!Number.isSafeInteger(deadline)) throw new Error("ordinary usage retention deadline overflows");
  return deadline;
}
export function assertOrdinaryUsageRetentionFacts(
  record: UsageReconciliationRecord, facts: BillingUsageFact[],
  expected?: OrdinarySessionUsageRetentionReceipt,
): void {
  if (facts.length > ORDINARY_USAGE_RETENTION_MAX_FACTS) throw new Error("ordinary usage retention receipt capacity exceeded");
  if (!usageReconciliationSummariesEqual(record, summarizeBillingUsageFacts(facts))
    || (expected && (expected.checksum !== record.checksum || expected.facts.length !== facts.length
      || expected.facts.some((v, i) => v.usageId !== facts[i]?.usageId || v.factSha256 !== facts[i]?.factSha256)))) {
    throw new Error("ordinary usage retention billing proof changed");
  }
}
export function assertOrdinaryUsageRetentionReplay(
  source: OrdinarySessionUsageRetentionSource, sourceSha256: string,
  grace: OrdinarySessionDeleteGraceEvidence, receipt: OrdinarySessionUsageRetentionReceipt,
  deletion: RetentionPolicyVersionRecord, originalCurrent: RetentionPolicyVersionRecord,
): void {
  const deadline = ordinaryUsageRetentionDeadline(grace, deletion, originalCurrent);
  if (source.originSha256 !== grace.originSha256 || source.policyVersion !== deletion.policyVersion
    || source.policySha256 !== deletion.policySha256 || receipt.deletionPolicySha256 !== source.policySha256
    || receipt.sourceSha256 !== sourceSha256 || receipt.sealSha256 !== grace.sealSha256
    || receipt.currentPolicyVersion !== originalCurrent.policyVersion || receipt.currentPolicySha256 !== originalCurrent.policySha256
    || deadline === null || receipt.deadlineDbMs !== deadline
    || receipt.executedAtDbMs < Math.max(deadline, deletion.createdAtMs, originalCurrent.createdAtMs)) {
    throw new Error("ordinary usage retention exact policy/source replay changed");
  }
}
