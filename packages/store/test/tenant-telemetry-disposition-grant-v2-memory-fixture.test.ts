import { describe, expect, it } from "vitest";
import {
  TENANT_TELEMETRY_DISPOSITION_AUTHORIZATION_GRANT_SCOPE,
  TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
  TenantTelemetryDispositionConflictError,
  TenantTelemetryDispositionCorruptError,
  tenantTelemetryDispositionAuthorizationGrantSha256,
  tenantTelemetryDispositionOperationSha256,
  type TenantTelemetryDispositionAuthorizationGrant,
} from "../src/tenant-telemetry-disposition.js";
import {
  assertTenantTelemetryGrantAuthorizationMatchesV2,
  assertTenantTelemetryGrantJournalChainV2,
  buildFixtureTenantTelemetryGrantAuthorizationEventV2,
  emptyTenantTelemetryGrantJournalHeadV2,
  validateTenantTelemetryGrantAuthorizationEventV2,
} from "../src/tenant-telemetry-disposition-adapter/grant-v2.js";
import {
  MemoryTenantTelemetryGrantJournalFixtureV2,
} from "../src/tenant-telemetry-disposition-adapter/grant-v2-memory-fixture.js";
import { dispositionDigest, dispositionEvidence } from "./tenant-telemetry-disposition.fixture.js";

function grant(index = 1, overrides: Partial<{
  tenantId: string;
  requestId: string;
  claimAttempt: number;
  claimTokenSha256: string;
  grantedAtDbMs: number;
  leaseUntilDbMs: number;
}> = {}): TenantTelemetryDispositionAuthorizationGrant {
  const body = {
    scope: TENANT_TELEMETRY_DISPOSITION_AUTHORIZATION_GRANT_SCOPE,
    protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
    tenantId: `private-tenant-${index}`,
    requestId: `private-request-${index}`,
    ...dispositionEvidence(index),
    claimAttempt: 1,
    claimTokenSha256: dispositionDigest(`claim-${index}`),
    grantedAtDbMs: 1_000,
    leaseUntilDbMs: 2_000,
    ...overrides,
  };
  return {
    ...body,
    grantReceiptSha256: tenantTelemetryDispositionAuthorizationGrantSha256(body),
  };
}

function fixture(overrides: Partial<ConstructorParameters<
  typeof MemoryTenantTelemetryGrantJournalFixtureV2
>[0]> = {}): MemoryTenantTelemetryGrantJournalFixtureV2 {
  return new MemoryTenantTelemetryGrantJournalFixtureV2({
    nonProductionFixture: true,
    namespaceId: "grant-v2-fixture",
    targetId: "grant-v2-target",
    failureDomainId: "memory-process",
    logicalDatabaseNamespaceSha256: dispositionDigest("grant-v2-database"),
    ...overrides,
  });
}

describe("grant-bound telemetry journal v2 non-production fixture", () => {
  it("keeps grant identity, claim, tenant and request bound without serializing raw IDs", async () => {
    const journal = fixture();
    const sealed = await journal.readHead();
    const source = grant();
    const event = await journal.appendFixtureAuthorization(source, sealed);
    expect(event.journalSequence).toBe(1);
    expect(event.grantReceiptSha256).toBe(source.grantReceiptSha256);
    expect(event.claimTokenSha256).toBe(source.claimTokenSha256);
    expect(event).not.toHaveProperty("tenantId");
    expect(event).not.toHaveProperty("requestId");
    expect(JSON.stringify(event)).not.toContain(source.tenantId);
    expect(JSON.stringify(event)).not.toContain(source.requestId);
    expect(await journal.appendFixtureAuthorization(source, sealed)).toEqual(event);
    await expect(journal.appendFixtureAuthorization(source, {
      ...sealed,
      journalTargetSha256: dispositionDigest("other-journal"),
    })).rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
    await expect(journal.appendFixtureAuthorization(source, {
      ...(await journal.readHead()),
      journalEventRootSha256: dispositionDigest("unrelated-head"),
    })).rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
    assertTenantTelemetryGrantAuthorizationMatchesV2(event, source);
    for (const changed of [
      grant(1, { tenantId: "private-other-tenant" }),
      grant(1, { requestId: "private-other-request" }),
      grant(1, { claimAttempt: 2 }),
      grant(1, { claimTokenSha256: dispositionDigest("other-claim") }),
      grant(1, { grantedAtDbMs: 1_001 }),
      grant(1, { leaseUntilDbMs: 2_001 }),
    ]) {
      expect(() => assertTenantTelemetryGrantAuthorizationMatchesV2(event, changed))
        .toThrow(TenantTelemetryDispositionConflictError);
      await expect(journal.appendFixtureAuthorization(changed, sealed))
        .rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
    }
  });

  it("rejects a forged receipt and never exposes an authorizeDeletion product method", async () => {
    const journal = fixture();
    expect("authorizeDeletion" in journal).toBe(false);
    const head = await journal.readHead();
    await expect(journal.appendFixtureAuthorization({
      ...grant(),
      grantReceiptSha256: dispositionDigest("forged-receipt"),
    }, head)).rejects.toThrow("receipt does not match");
    expect((await journal.readHead()).journalSequence).toBe(0);
  });

  it("requires exact CAS head, serializes concurrent fixture appends, and replays response loss", async () => {
    let loseOnce = true;
    const journal = fixture({
      afterEventCommit: () => {
        if (loseOnce) {
          loseOnce = false;
          throw new Error("simulated response loss");
        }
      },
    });
    const genesis = await journal.readHead();
    await expect(journal.appendFixtureAuthorization(grant(2), genesis))
      .rejects.toThrow("response loss");
    const replay = await journal.appendFixtureAuthorization(grant(2), genesis);
    expect(replay.journalSequence).toBe(1);
    await expect(journal.appendFixtureAuthorization(grant(3), genesis))
      .rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
    const next = await journal.readHead();
    const settled = await Promise.allSettled([
      journal.appendFixtureAuthorization(grant(3), next),
      journal.appendFixtureAuthorization(grant(4), next),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await journal.readHead()).journalSequence).toBe(2);
  });

  it("validates the exact sealed chain and rejects mutation, rollback, mixed protocol and duplicate artifact", async () => {
    const journal = fixture();
    const genesis = await journal.readHead();
    const first = await journal.appendFixtureAuthorization(grant(5), genesis);
    const sealed = await journal.readHead();
    await journal.appendFixtureAuthorization(grant(6), sealed);
    const prefix = await journal.scanSealedEvents(sealed);
    expect(prefix).toEqual([first]);
    assertTenantTelemetryGrantJournalChainV2(journal, prefix, sealed);
    expect(() => assertTenantTelemetryGrantJournalChainV2(journal, prefix, genesis))
      .toThrow(TenantTelemetryDispositionCorruptError);
    expect(() => validateTenantTelemetryGrantAuthorizationEventV2({
      ...first,
      claimAttempt: 2,
    })).toThrow(TenantTelemetryDispositionCorruptError);
    expect(() => validateTenantTelemetryGrantAuthorizationEventV2({
      ...first,
      protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
    } as never)).toThrow(TenantTelemetryDispositionCorruptError);
    const original = grant(5);
    const changedEvidence = {
      ...dispositionEvidence(5),
      t3dPlanEntryReceiptSha256: dispositionDigest("different-plan-entry"),
    };
    const { dispositionOperationSha256: _oldOperation, ...operationBody } = changedEvidence;
    const changedBody = {
      ...original,
      ...operationBody,
      dispositionOperationSha256: tenantTelemetryDispositionOperationSha256(operationBody),
    };
    const { grantReceiptSha256: _oldReceipt, ...grantBody } = changedBody;
    const differentOperationSameArtifact = {
      ...grantBody,
      grantReceiptSha256: tenantTelemetryDispositionAuthorizationGrantSha256(grantBody),
    };
    await expect(journal.appendFixtureAuthorization(
      differentOperationSameArtifact,
      await journal.readHead(),
    )).rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
  });

  it("keeps v1 and v2 identity separate and refuses production fixture construction", async () => {
    const journal = fixture();
    const genesis = await journal.readHead();
    const identity = {
      adapterProtocol: journal.adapterProtocol,
      journalNamespaceSha256: journal.journalNamespaceSha256,
      journalTargetSha256: journal.journalTargetSha256,
      failureDomainSha256: journal.failureDomainSha256,
      logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256,
    };
    const built = buildFixtureTenantTelemetryGrantAuthorizationEventV2(
      identity, grant(7), genesis, true,
    );
    expect(emptyTenantTelemetryGrantJournalHeadV2({
      ...identity,
      tenantId: "private-should-not-serialize",
    } as never)).not.toHaveProperty("tenantId");
    expect(built.journalEventRootSha256).not.toBe(
      emptyTenantTelemetryGrantJournalHeadV2(identity).journalEventRootSha256,
    );
    expect(() => emptyTenantTelemetryGrantJournalHeadV2({
      ...identity,
      adapterProtocol: "memory-tenant-telemetry-disposition-journal-fixture-v1",
    })).toThrow(TenantTelemetryDispositionCorruptError);
    expect(() => new MemoryTenantTelemetryGrantJournalFixtureV2({
      nonProductionFixture: false,
      namespaceId: "grant-v2-fixture",
      targetId: "grant-v2-target",
      failureDomainId: "memory-process",
      logicalDatabaseNamespaceSha256: dispositionDigest("grant-v2-database"),
    } as never)).toThrow("non-production fixture");
    await journal.close();
    await expect(journal.readHead()).rejects.toThrow("closed");
  });
});
