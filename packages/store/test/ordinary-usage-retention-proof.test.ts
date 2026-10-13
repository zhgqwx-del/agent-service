import { createHash } from "node:crypto";
import { emptyUsage } from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import {
  assertPriorRetainedBillingFactProof,
  billingUsageFactFromLedger,
  priorRetainedBillingFactProofSha256,
  subtractPriorRetainedBillingFacts,
  TENANT_PURGE_SESSION_GRAVE_MARKER_SCOPE,
  tenantDatabasePurgeSessionGraveMarkerSha256,
  validateTenantDatabasePurgeSessionGraveMarker,
  type PriorRetainedBillingProofIdentity,
  type TenantPurgeSessionGraveMarker,
} from "../src/index.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const identity: PriorRetainedBillingProofIdentity = {
  tenantId: "tenant-proof",
  requestId: "erase_12345678-1234-4123-8123-123456789abc",
  subjectGeneration: 1,
  planBuildGeneration: 2,
  executionGeneration: 3,
  databasePurgeGeneration: 1,
  preDeleteReceiptSha256: A,
  localPhysicalAckReceiptSha256: B,
};
const usageId = (index: number) => `usg_00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const identities = (count: number) => Array.from({ length: count }, (_, i) => ({
  usageId: usageId(i + 1), factSha256: A,
}));
function fact(index: number, tenantId = identity.tenantId) {
  return billingUsageFactFromLedger({
    usageId: usageId(index), tenantId, userId: "user-proof",
    sessionId: "sess_0199aabb-ccdd-7001-8000-000000000052",
    turnId: "turn_0199aabb-ccdd-7001-8000-000000000052", step: 1,
    provider: "provider", model: "model", usage: emptyUsage(), createdAtMs: 1_760_000_000_000,
  });
}
const grave: Omit<TenantPurgeSessionGraveMarker, "markerSha256"> = {
  tenantId: identity.tenantId, requestId: identity.requestId,
  subjectGeneration: 1, planBuildGeneration: 2, executionGeneration: 3, databasePurgeGeneration: 1,
  scope: TENANT_PURGE_SESSION_GRAVE_MARKER_SCOPE,
  sessionId: "sess_0199aabb-ccdd-7001-8000-000000000052", deletionGeneration: 1,
  deletedAtDbMs: 10, ownerSha256: A, t3cSessionReceiptSha256: B,
  preDeleteReceiptSha256: A, markedAtDbMs: 20,
};

describe("ordinary usage retention durable proof codecs", () => {
  it("seals an explicit empty bridge and does not impose a per-session cap on a tenant aggregate", () => {
    for (const facts of [[], identities(10_001)]) {
      const proof = { schemaVersion: 1 as const, facts,
        evidenceSha256: priorRetainedBillingFactProofSha256(identity, facts) };
      expect(() => assertPriorRetainedBillingFactProof(identity, proof)).not.toThrow();
    }
  });

  it.each(Object.keys(identity) as (keyof PriorRetainedBillingProofIdentity)[])(
    "binds the bridge to its exact %s", (key) => {
      const facts = identities(1);
      const proof = { schemaVersion: 1 as const, facts,
        evidenceSha256: priorRetainedBillingFactProofSha256(identity, facts) };
      const changed = { ...identity, [key]: typeof identity[key] === "number" ? 4
        : key.endsWith("Sha256") ? "c".repeat(64) : `${identity[key]}-other` };
      expect(() => assertPriorRetainedBillingFactProof(changed, proof)).toThrow(/bridge changed/);
    },
  );

  it("rejects duplicate, unordered, malformed and owner-bearing fact identities", () => {
    const one = identities(1)[0]!;
    for (const facts of [
      [one, one], identities(2).reverse(), [{ ...one, usageId: "raw-session-id" }],
      [{ ...one, factSha256: "bad" }], [{ ...one, userId: "user-proof" }],
    ]) expect(() => priorRetainedBillingFactProofSha256(identity, facts)).toThrow();
    const facts = [one];
    const proof = { schemaVersion: 1 as const, facts,
      evidenceSha256: priorRetainedBillingFactProofSha256(identity, facts), owner: "user-proof" };
    expect(() => assertPriorRetainedBillingFactProof(identity, proof)).toThrow();
  });

  it("subtracts only exact retained identities and rejects missing, conflicting, duplicate or foreign facts", () => {
    const prior = fact(1);
    const remaining = fact(2);
    const proof = [{ usageId: prior.usageId, factSha256: prior.factSha256 }];
    expect(subtractPriorRetainedBillingFacts(identity.tenantId, [remaining, prior], proof)).toEqual([remaining]);
    expect(() => subtractPriorRetainedBillingFacts(identity.tenantId, [remaining], proof)).toThrow();
    expect(() => subtractPriorRetainedBillingFacts(identity.tenantId, [prior], [{ ...proof[0]!, factSha256: A }])).toThrow();
    expect(() => subtractPriorRetainedBillingFacts(identity.tenantId, [prior, prior], proof)).toThrow();
    expect(() => subtractPriorRetainedBillingFacts(identity.tenantId, [prior], [proof[0]!, proof[0]!])).toThrow();
    const foreign = fact(1, "tenant-foreign");
    expect(() => subtractPriorRetainedBillingFacts(identity.tenantId, [foreign], [
      { usageId: foreign.usageId, factSha256: foreign.factSha256 },
    ])).toThrow();
  });

  it("keeps the pre-0052 grave canonical hash byte-for-byte unchanged", () => {
    const expected = createHash("sha256").update(JSON.stringify([
      "tenant-purge-session-grave-marker-v1", grave.scope,
      grave.requestId, grave.tenantId, grave.subjectGeneration, grave.planBuildGeneration,
      grave.executionGeneration, grave.databasePurgeGeneration, grave.sessionId,
      grave.deletionGeneration, grave.deletedAtDbMs, grave.ownerSha256,
      grave.t3cSessionReceiptSha256, grave.preDeleteReceiptSha256, grave.markedAtDbMs,
    ])).digest("hex");
    expect(tenantDatabasePurgeSessionGraveMarkerSha256(grave)).toBe(expected);
    expect(() => validateTenantDatabasePurgeSessionGraveMarker({ ...grave, markerSha256: expected })).not.toThrow();
  });

  it.each([null, B])("binds the v2 grave source and nullable receipt %s without reinterpreting legacy", (receiptSha256) => {
    const body = { ...grave, ordinaryUsageRetention: { sourceSha256: A, receiptSha256 } };
    const markerSha256 = tenantDatabasePurgeSessionGraveMarkerSha256(body);
    expect(markerSha256).not.toBe(tenantDatabasePurgeSessionGraveMarkerSha256(grave));
    expect(() => validateTenantDatabasePurgeSessionGraveMarker({ ...body, markerSha256 })).not.toThrow();
    expect(() => validateTenantDatabasePurgeSessionGraveMarker({ ...body, markerSha256,
      ordinaryUsageRetention: { ...body.ordinaryUsageRetention, sourceSha256: B },
    })).toThrow();
    expect(() => validateTenantDatabasePurgeSessionGraveMarker({ ...grave, markerSha256 })).toThrow();
  });
});
