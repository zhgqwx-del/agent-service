import { describe, expect, it } from "vitest";
import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  MemoryTenantBackupCatalogAdapter,
  TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
  TENANT_BACKUP_CATALOG_PROTOCOL,
  TenantBackupCatalogAdapterConflictError,
  tenantBackupCatalogEntrySha256,
  tenantBackupEvictionOperationSha256,
  tenantBackupEvictionPlanSha256,
  type PublishTenantBackupAvailabilityInput,
  type TenantBackupEvictionPlan,
} from "../src/index.js";

const BACKUP_A = "backup_00000000-0000-4000-8000-000000000031";
const BACKUP_B = "backup_00000000-0000-4000-8000-000000000032";
const RESTORE_A = "restore_00000000-0000-4000-8000-000000000031";
const RESTORE_B = "restore_00000000-0000-4000-8000-000000000032";
const EVICTION_A = "backup_evict_00000000-0000-4000-8000-000000000031";

function digest(character: string): string {
  return character.repeat(64);
}

function adapter(afterEventCommit?: ConstructorParameters<
  typeof MemoryTenantBackupCatalogAdapter
>[0]["afterEventCommit"]): MemoryTenantBackupCatalogAdapter {
  return new MemoryTenantBackupCatalogAdapter({
    nonProductionFixture: true,
    namespaceId: "catalog-test",
    targetId: "target-a",
    failureDomainId: "process-a",
    afterEventCommit,
  });
}

function availability(
  backupId = BACKUP_A,
  suffix = "a",
): PublishTenantBackupAvailabilityInput {
  const registeredAtDbMs = suffix === "a" ? 100 : 200;
  return {
    backupId,
    anchorSha256: digest(suffix),
    sourceSnapshotSha256: digest(suffix === "a" ? "b" : "8"),
    sourceBackupSha256: digest(suffix === "a" ? "c" : "9"),
    artifactManifestSha256: digest(suffix === "a" ? "d" : "0"),
    providerEvidenceSha256: digest(suffix === "a" ? "e" : "1"),
    controlEvidenceSha256: digest(suffix === "a" ? "f" : "2"),
    logicalDatabaseNamespaceSha256: digest("3"),
    retentionPolicySha256: digest("4"),
    retentionUntilDbMs: registeredAtDbMs + 1_000,
    registeredAtDbMs,
  };
}

function evictionPlan(input: {
  source: PublishTenantBackupAvailabilityInput;
  entrySha256: string;
  headSequence: number;
  headRootSha256: string;
}): TenantBackupEvictionPlan {
  const source = {
    evictionId: EVICTION_A,
    backupId: input.source.backupId,
    anchorSha256: input.source.anchorSha256,
    entrySha256: input.entrySha256,
    sourceSnapshotSha256: input.source.sourceSnapshotSha256,
    sourceBackupSha256: input.source.sourceBackupSha256,
    artifactManifestSha256: input.source.artifactManifestSha256,
    providerEvidenceSha256: input.source.providerEvidenceSha256,
    controlEvidenceSha256: input.source.controlEvidenceSha256,
    retentionPolicySha256: input.source.retentionPolicySha256,
    retentionUntilDbMs: input.source.retentionUntilDbMs,
    expectedCatalogSequence: input.headSequence,
    expectedCatalogEventRootSha256: input.headRootSha256,
  };
  const evictionOperationSha256 = tenantBackupEvictionOperationSha256(source);
  const withOperation = { ...source, evictionOperationSha256 };
  return {
    ...withOperation,
    planSha256: tenantBackupEvictionPlanSha256(withOperation),
  };
}

describe("MemoryTenantBackupCatalogAdapter", () => {
  it("publishes immutable availability with exact replay and a verifiable scan", async () => {
    const subject = adapter();
    const input = availability();
    const empty = await subject.readHead();
    expect(empty).toMatchObject({
      catalogSequence: 0,
      catalogEventRootSha256: EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
    });

    const created = await subject.publishAvailability(input);
    expect(created).toMatchObject(input);
    const { entrySha256, ...entryEvidence } = created;
    expect(entrySha256).toBe(tenantBackupCatalogEntrySha256({
      scope: TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
      protocol: TENANT_BACKUP_CATALOG_PROTOCOL,
      ...entryEvidence,
    }));
    await expect(subject.publishAvailability(input)).resolves.toEqual(created);
    await expect(subject.publishAvailability({
      ...availability(),
      sourceBackupSha256: digest("f"),
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);

    const sealedHead = await subject.readHead();
    const page = await subject.scanEvents({
      afterCatalogSequence: 0,
      afterCatalogEventRootSha256: EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      sealedHead,
      limit: 1,
    });
    expect(page.events).toEqual([{ eventType: "backup_recoverable", result: created }]);
    expect(page).toMatchObject({
      nextCatalogSequence: 1,
      nextCatalogEventRootSha256: sealedHead.catalogEventRootSha256,
      complete: true,
    });
  });

  it("recovers exactly after the external commit response is lost", async () => {
    let loseResponse = true;
    const subject = adapter(() => {
      if (loseResponse) {
        loseResponse = false;
        throw new Error("simulated response loss");
      }
    });
    await expect(subject.publishAvailability(availability())).rejects.toThrow(
      "simulated response loss",
    );
    const replay = await subject.publishAvailability(availability());
    expect(replay.catalogSequence).toBe(1);
    expect((await subject.readHead()).catalogSequence).toBe(1);
  });

  it("linearizes concurrent writers into one global event chain", async () => {
    const subject = adapter();
    const results = await Promise.all([
      subject.publishAvailability(availability(BACKUP_A, "a")),
      subject.publishAvailability(availability(BACKUP_B, "7")),
    ]);
    expect(results.map((result) => result.catalogSequence).sort()).toEqual([1, 2]);
    expect((await subject.readHead()).catalogSequence).toBe(2);
  });

  it("burns runtime epochs, resolves reservations, and exact-replays eviction ACKs", async () => {
    const subject = adapter();
    const source = availability();
    const otherSource = availability(BACKUP_B, "7");
    const entry = await subject.publishAvailability(source);
    const otherEntry = await subject.publishAvailability(otherSource);
    const beforeRejectedEntry = await subject.readHead();
    await expect(subject.reserveRestore({
      backupId: BACKUP_A,
      restoreRunId: RESTORE_A,
      entrySha256: digest("2"),
      runtimeEpochSha256: digest("5"),
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
    await expect(subject.readHead()).resolves.toEqual(beforeRejectedEntry);
    const reservation = await subject.reserveRestore({
      backupId: BACKUP_A,
      restoreRunId: RESTORE_A,
      entrySha256: entry.entrySha256,
      runtimeEpochSha256: digest("5"),
    });
    const activeHead = await subject.readHead();
    await expect(subject.reserveRestore({
      backupId: BACKUP_B,
      restoreRunId: RESTORE_B,
      entrySha256: otherEntry.entrySha256,
      runtimeEpochSha256: digest("6"),
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
    await expect(subject.readHead()).resolves.toEqual(activeHead);
    await expect(subject.resolveRestore({
      restoreRunId: RESTORE_A,
      reservationReceiptSha256: digest("6"),
      phase: "aborted",
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
    await expect(subject.readHead()).resolves.toEqual(activeHead);
    await subject.resolveRestore({
      restoreRunId: RESTORE_A,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "aborted",
    });
    await expect(subject.reserveRestore({
      backupId: BACKUP_B,
      restoreRunId: RESTORE_B,
      entrySha256: otherEntry.entrySha256,
      runtimeEpochSha256: digest("5"),
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
    const otherReservation = await subject.reserveRestore({
      backupId: BACKUP_B,
      restoreRunId: RESTORE_B,
      entrySha256: otherEntry.entrySha256,
      runtimeEpochSha256: digest("6"),
    });
    await subject.resolveRestore({
      restoreRunId: RESTORE_B,
      reservationReceiptSha256: otherReservation.reservationReceiptSha256,
      phase: "aborted",
    });

    const head = await subject.readHead();
    const plan = evictionPlan({
      source,
      entrySha256: entry.entrySha256,
      headSequence: head.catalogSequence,
      headRootSha256: head.catalogEventRootSha256,
    });
    const input = {
      plan,
      externalTombstoneSha256: digest("7"),
      observedAbsent: true as const,
    };
    const committed = await subject.recordEviction(input);
    await expect(subject.recordEviction(input)).resolves.toEqual(committed);
    expect(reservation.catalogSequence).toBe(3);
    expect(committed.catalogSequence).toBe(7);
  });

  it("rejects stale eviction selection after another catalog event", async () => {
    const subject = adapter();
    const source = availability();
    const entry = await subject.publishAvailability(source);
    const head = await subject.readHead();
    const stalePlan = evictionPlan({
      source,
      entrySha256: entry.entrySha256,
      headSequence: head.catalogSequence,
      headRootSha256: head.catalogEventRootSha256,
    });
    await subject.publishAvailability(availability(BACKUP_B, "7"));
    await expect(subject.recordEviction({
      plan: stalePlan,
      externalTombstoneSha256: digest("7"),
      observedAbsent: true,
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
  });
});
