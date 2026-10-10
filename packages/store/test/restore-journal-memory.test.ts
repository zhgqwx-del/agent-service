import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  TENANT_RESTORE_JOURNAL_PROTOCOL,
  TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
  tenantRestoreJournalOperationSha256,
  tenantRestoreJournalRecordSha256,
  validateScanTenantRestoreJournalRecordsResult,
  validateTenantRestoreJournalAdapterResult,
  type TenantRestoreJournalRecord,
} from "../src/tenant-restore-journal.js";
import {
  MemoryTenantRestoreJournalAdapter,
  memoryTenantRestoreJournalFailureDomainSha256,
  memoryTenantRestoreJournalNamespaceSha256,
  memoryTenantRestoreJournalTargetSha256,
} from "../src/restore-journal/memory.js";
import { TenantRestoreJournalConflictError } from "../src/restore-journal/common.js";

const LOGICAL_DATABASE_NAMESPACE_SHA256 = "a".repeat(64);
const T1_FENCE_SHA256 = "c".repeat(64);
const NAMESPACE_ID = "unit-journal-set";
const FAILURE_DOMAIN_ID = "unit-fake-process";
const TARGET_ID = "fixture-target-a";

function record(
  requestId = "erase_12345678-1234-4234-8234-123456789abc",
  tenantId = "tenant-a",
  subjectGeneration = 1,
): TenantRestoreJournalRecord {
  const operationSha256 = tenantRestoreJournalOperationSha256({
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    requestId,
    tenantId,
    subjectGeneration,
    t1FenceSha256: T1_FENCE_SHA256,
  });
  const body = {
    scope: TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
    protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    requestId,
    tenantId,
    subjectGeneration,
    t1FenceSha256: T1_FENCE_SHA256,
    operationSha256,
  } as const;
  return { ...body, recordSha256: tenantRestoreJournalRecordSha256(body) };
}

function adapter(overrides: Partial<ConstructorParameters<typeof MemoryTenantRestoreJournalAdapter>[0]> = {}) {
  return new MemoryTenantRestoreJournalAdapter({
    nonProductionFixture: true,
    namespaceId: NAMESPACE_ID,
    failureDomainId: FAILURE_DOMAIN_ID,
    targetId: TARGET_ID,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MemoryTenantRestoreJournalAdapter non-production fixture", () => {
  it("requires explicit non-production use and derives a content-free namespace", () => {
    expect(() => new MemoryTenantRestoreJournalAdapter({
      nonProductionFixture: false,
      namespaceId: NAMESPACE_ID,
      failureDomainId: FAILURE_DOMAIN_ID,
      targetId: TARGET_ID,
      logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    } as unknown as ConstructorParameters<typeof MemoryTenantRestoreJournalAdapter>[0])).toThrow(
      "non-production fixture",
    );
    vi.stubEnv("NODE_ENV", "production");
    expect(() => adapter()).toThrow("non-production fixture");
    vi.stubEnv("NODE_ENV", "test");
    const first = adapter();
    const second = adapter();
    const other = adapter({ namespaceId: "other-domain" });
    expect(first.journalNamespaceSha256).toBe(second.journalNamespaceSha256);
    expect(first.journalNamespaceSha256).not.toBe(other.journalNamespaceSha256);
    expect(first.journalNamespaceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.journalNamespaceSha256).toBe(
      memoryTenantRestoreJournalNamespaceSha256(NAMESPACE_ID),
    );
    expect(first.failureDomainSha256).toBe(
      memoryTenantRestoreJournalFailureDomainSha256(FAILURE_DOMAIN_ID),
    );
    expect(first.targetSha256).toBe(memoryTenantRestoreJournalTargetSha256({
      journalNamespaceSha256: first.journalNamespaceSha256,
      failureDomainSha256: first.failureDomainSha256,
      logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
      targetId: TARGET_ID,
    }));
    expect(adapter({ targetId: "fixture-target-b" }).targetSha256).not.toBe(first.targetSha256);
    expect(adapter({ failureDomainId: "other-fake-process" }).targetSha256)
      .not.toBe(first.targetSha256);
  });

  it("publishes immutable records, makes exact retries idempotent, and scans a sealed prefix", async () => {
    const store = adapter();
    const firstRecord = record();
    const secondRecord = record("erase_22345678-1234-4234-8234-123456789abc", "tenant-b", 2);
    const thirdRecord = record("erase_32345678-1234-4234-8234-123456789abc", "tenant-c", 3);

    const first = await store.publishRecord(firstRecord);
    validateTenantRestoreJournalAdapterResult(first);
    expect(first).toMatchObject({ remoteSequence: 1, replayed: false, record: firstRecord });
    const replay = await store.publishRecord(structuredClone(firstRecord));
    expect(replay).toMatchObject({ remoteSequence: 1, replayed: true, record: firstRecord });
    await store.publishRecord(secondRecord);
    const sealedHead = await store.readHead();
    expect(sealedHead.remoteSequence).toBe(2);
    await store.publishRecord(thirdRecord);
    expect((await store.readHead()).remoteSequence).toBe(3);

    const firstPageOptions = {
      sealedHead,
      afterRemoteSequence: 0,
      afterHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
      limit: 1,
    };
    const firstPage = await store.scanRecords(firstPageOptions);
    validateScanTenantRestoreJournalRecordsResult(firstPageOptions, firstPage);
    expect(firstPage).toMatchObject({ nextRemoteSequence: 1, complete: false });
    expect(firstPage.entries.map((entry) => entry.record.operationSha256)).toEqual([
      firstRecord.operationSha256,
    ]);
    const secondPageOptions = {
      sealedHead,
      afterRemoteSequence: firstPage.nextRemoteSequence,
      afterHeadRootSha256: firstPage.nextHeadRootSha256,
      limit: 10,
    };
    const secondPage = await store.scanRecords(secondPageOptions);
    validateScanTenantRestoreJournalRecordsResult(secondPageOptions, secondPage);
    expect(secondPage.complete).toBe(true);
    expect(secondPage.entries.map((entry) => entry.record.operationSha256)).toEqual([
      secondRecord.operationSha256,
    ]);
    await expect(store.inspectRecord(firstRecord)).resolves.toMatchObject({
      remoteSequence: 1,
      replayed: true,
    });
  });

  it("does not acknowledge an orphan record and safely chains it on retry", async () => {
    let fail = true;
    const store = adapter({
      afterRecordCreate: () => {
        if (fail) {
          fail = false;
          throw new Error("simulated process loss after immutable record create");
        }
      },
    });
    const input = record();
    await expect(store.publishRecord(input)).rejects.toThrow("simulated process loss");
    await expect(store.inspectRecord(input)).resolves.toBeNull();
    await expect(store.readHead()).resolves.toMatchObject({
      remoteSequence: 0,
      headRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
    });
    await expect(store.publishRecord(input)).resolves.toMatchObject({
      remoteSequence: 1,
      replayed: false,
    });
  });

  it("serializes concurrent publications into one gap-free chain without duplicate operations", async () => {
    const store = adapter();
    const firstRecord = record();
    const secondRecord = record("erase_42345678-1234-4234-8234-123456789abc", "tenant-b", 2);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (
      store.publishRecord(index % 2 === 0 ? firstRecord : secondRecord)
    )));
    expect(new Set(results.map((result) => result.record.operationSha256))).toEqual(
      new Set([firstRecord.operationSha256, secondRecord.operationSha256]),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(2);
    const head = await store.readHead();
    expect(head.remoteSequence).toBe(2);
    const page = await store.scanRecords({
      sealedHead: head,
      afterRemoteSequence: 0,
      afterHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
      limit: 100,
    });
    expect(page.entries).toHaveLength(2);
    expect(new Set(page.entries.map((entry) => entry.record.operationSha256)).size).toBe(2);
  });

  it("fails closed on immutable content conflicts, foreign cursors, and use after close", async () => {
    const store = adapter();
    const firstRecord = record();
    const foreignRecord = record("erase_52345678-1234-4234-8234-123456789abc", "tenant-z", 9);
    (store as unknown as { records: Map<string, TenantRestoreJournalRecord> }).records.set(
      firstRecord.operationSha256,
      foreignRecord,
    );
    await expect(store.publishRecord(firstRecord)).rejects.toBeInstanceOf(
      TenantRestoreJournalConflictError,
    );

    const clean = adapter();
    await clean.publishRecord(firstRecord);
    const head = await clean.readHead();
    await expect(clean.scanRecords({
      sealedHead: head,
      afterRemoteSequence: 0,
      afterHeadRootSha256: "f".repeat(64),
      limit: 1,
    })).rejects.toThrow("initial scan cursor");
    await clean.close();
    await expect(clean.readHead()).rejects.toThrow("closed");
  });
});
