import { DEFAULT_AUTH_POLICY } from "@agent-service/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  MEMORY_TENANT_RESTORE_JOURNAL_PROTOCOL,
  TENANT_RESTORE_JOURNAL_CONTROL_SINGLETON_ID,
  TENANT_RESTORE_JOURNAL_PROTOCOL,
  TENANT_RESTORE_JOURNAL_PUBLICATION_RECEIPT_SCOPE,
  TENANT_RESTORE_JOURNAL_PUBLICATION_TARGET_ACK_SCOPE,
  TENANT_RESTORE_JOURNAL_PUBLICATION_TARGET_SCOPE,
  TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
  MemoryTenantRestoreJournalAdapter,
  MemorySessionStore,
  TenantErasureIntegrityError,
  TenantRestoreJournalCorruptError,
  TenantRestoreJournalPublicationDependencyPendingError,
  tenantRestoreJournalClaimTokenSha256,
  tenantRestoreJournalControlEvidenceSha256,
  tenantRestoreJournalOperationSha256,
  tenantRestoreJournalPublicationReceiptSha256,
  tenantRestoreJournalPublicationTargetAckRootSha256,
  tenantRestoreJournalPublicationTargetAckSha256,
  tenantRestoreJournalPublicationTargetSha256,
  tenantRestoreJournalRecordSha256,
  tenantRestoreJournalRemoteCommitRootSha256,
  tenantRestoreJournalTargetRootSha256,
  tenantErasureRequestHash,
  tenantRestoreLogicalDatabaseNamespaceSha256,
  tenantRestoreRuntimeEpochSha256,
  newErasureRequestId,
  type ClaimTenantRestoreJournalPublicationsOptions,
  type TenantRestoreJournalAdapter,
  type TenantRestoreJournalAdapterResult,
  type TenantRestoreJournalControlRecord,
  type TenantRestoreJournalPublicationAuthorization,
  type TenantRestoreJournalPublicationBlockReasonCode,
  type TenantRestoreJournalPublicationClaim,
  type TenantRestoreJournalPublicationReceipt,
  type TenantRestoreJournalPublicationRetryErrorCode,
  type TenantRestoreJournalPublicationTarget,
  type TenantRestoreJournalPublicationTargetAck,
  type TenantRestoreJournalRecord,
  type TenantRestoreJournalStore,
  type TenantRestoreJournalTargetDescriptor,
} from "@agent-service/store";
import { TenantRestoreJournalPublicationWorker } from "../src/index.js";

const REQUEST_ID = "erase_12345678-1234-4123-8123-123456789abc";
const TENANT_ID = "tenant-worker-fixture";
const LOGICAL_DATABASE_NAMESPACE_SHA256 = "a".repeat(64);
const T1_FENCE_SHA256 = "b".repeat(64);
const SOURCE_EVIDENCE_DB_MS = 1_000;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface FixtureOptions {
  targetCount?: number;
  orphanTargetOrdinal?: number;
  initialClaimAttempt?: number;
}

function fixture(options: FixtureOptions = {}) {
  const targetCount = options.targetCount ?? 2;
  const trace: string[] = [];
  const delegates: MemoryTenantRestoreJournalAdapter[] = [];
  const inspectMethods: Array<ReturnType<typeof vi.fn<TenantRestoreJournalAdapter["inspectRecord"]>>> = [];
  const publishMethods: Array<ReturnType<typeof vi.fn<TenantRestoreJournalAdapter["publishRecord"]>>> = [];
  const closeMethods: Array<ReturnType<typeof vi.fn<TenantRestoreJournalAdapter["close"]>>> = [];
  const orphanFailures = new Set<number>(
    options.orphanTargetOrdinal === undefined ? [] : [options.orphanTargetOrdinal],
  );
  const adapters: TenantRestoreJournalAdapter[] = Array.from(
    { length: targetCount },
    (_value, targetOrdinal) => {
      const delegate = new MemoryTenantRestoreJournalAdapter({
        nonProductionFixture: true,
        namespaceId: "publication-worker-journal-set",
        failureDomainId: `publication-worker-failure-${targetOrdinal}`,
        targetId: `publication-worker-target-${targetOrdinal}`,
        logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
        afterRecordCreate: () => {
          if (orphanFailures.delete(targetOrdinal)) {
            throw new Error("unsafe orphan failure with tenant and locator details");
          }
        },
      });
      delegates.push(delegate);
      const inspect = vi.fn<TenantRestoreJournalAdapter["inspectRecord"]>(async (record) => {
        trace.push(`inspect:${targetOrdinal}`);
        return delegate.inspectRecord(record);
      });
      const publish = vi.fn<TenantRestoreJournalAdapter["publishRecord"]>(async (record) => {
        trace.push(`publish:${targetOrdinal}`);
        return delegate.publishRecord(record);
      });
      const close = vi.fn<TenantRestoreJournalAdapter["close"]>(async () => {
        trace.push(`close:${targetOrdinal}`);
        await delegate.close();
      });
      inspectMethods.push(inspect);
      publishMethods.push(publish);
      closeMethods.push(close);
      return {
        adapterProtocol: delegate.adapterProtocol,
        journalNamespaceSha256: delegate.journalNamespaceSha256,
        targetSha256: delegate.targetSha256,
        failureDomainSha256: delegate.failureDomainSha256,
        logicalDatabaseNamespaceSha256: delegate.logicalDatabaseNamespaceSha256,
        inspectRecord: inspect,
        publishRecord: publish,
        readHead: () => delegate.readHead(),
        scanRecords: (input) => delegate.scanRecords(input),
        close,
      };
    },
  );

  const catalog: TenantRestoreJournalTargetDescriptor[] = adapters.map((adapter, targetOrdinal) => ({
    targetOrdinal,
    targetSha256: adapter.targetSha256,
    failureDomainSha256: adapter.failureDomainSha256,
    adapterProtocol: adapter.adapterProtocol,
    journalNamespaceSha256: adapter.journalNamespaceSha256,
  }));
  const targetRootSha256 = tenantRestoreJournalTargetRootSha256(catalog);
  const controlBody = {
    singletonId: TENANT_RESTORE_JOURNAL_CONTROL_SINGLETON_ID,
    controlGeneration: 1 as const,
    activatedAtDbMs: 900,
    protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
    adapterProtocol: MEMORY_TENANT_RESTORE_JOURNAL_PROTOCOL,
    journalNamespaceSha256: adapters[0]!.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    targetCount,
    targetRootSha256,
  };
  const control: Extract<TenantRestoreJournalControlRecord, { controlGeneration: 1 }> = {
    ...controlBody,
    evidenceSha256: tenantRestoreJournalControlEvidenceSha256(controlBody),
  };
  const operationSha256 = tenantRestoreJournalOperationSha256({
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    requestId: REQUEST_ID,
    tenantId: TENANT_ID,
    subjectGeneration: 1,
    t1FenceSha256: T1_FENCE_SHA256,
  });
  const recordBody = {
    scope: TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
    protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    requestId: REQUEST_ID,
    tenantId: TENANT_ID,
    subjectGeneration: 1,
    t1FenceSha256: T1_FENCE_SHA256,
    operationSha256,
  } as const;
  const record: TenantRestoreJournalRecord = {
    ...recordBody,
    recordSha256: tenantRestoreJournalRecordSha256(recordBody),
  };
  const targets: TenantRestoreJournalPublicationTarget[] = catalog.map((configured) => {
    const body = {
      requestId: REQUEST_ID,
      tenantId: TENANT_ID,
      subjectGeneration: 1,
      publicationGeneration: 1,
      scope: TENANT_RESTORE_JOURNAL_PUBLICATION_TARGET_SCOPE,
      targetOrdinal: configured.targetOrdinal,
      targetSha256: configured.targetSha256,
      failureDomainSha256: configured.failureDomainSha256,
      adapterProtocol: configured.adapterProtocol,
      journalNamespaceSha256: configured.journalNamespaceSha256,
      logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
      t1FenceSha256: T1_FENCE_SHA256,
      operationSha256,
      recordSha256: record.recordSha256,
      capturedAtDbMs: SOURCE_EVIDENCE_DB_MS,
    };
    return {
      ...body,
      receiptSha256: tenantRestoreJournalPublicationTargetSha256(body),
    };
  });
  const source = {
    requestId: REQUEST_ID,
    tenantId: TENANT_ID,
    subjectGeneration: 1,
    publicationGeneration: 1,
    t1FenceSha256: T1_FENCE_SHA256,
    controlEvidenceSha256: control.evidenceSha256,
    adapterProtocol: control.adapterProtocol,
    journalNamespaceSha256: control.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: control.logicalDatabaseNamespaceSha256,
    targetCount,
    targetRootSha256,
    sourceEvidenceDbMs: SOURCE_EVIDENCE_DB_MS,
  };

  let phase: "queued" | "published" | "blocked" = "queued";
  let claimed = false;
  let claimAttempt = options.initialClaimAttempt ?? 0;
  let activeToken: string | undefined;
  let receipt: TenantRestoreJournalPublicationReceipt | undefined;
  let acks: TenantRestoreJournalPublicationTargetAck[] = [];
  let blockReason: TenantRestoreJournalPublicationBlockReasonCode | undefined;
  const retries: Array<{
    authorization: TenantRestoreJournalPublicationAuthorization;
    options: { delayMs: number; errorCode: TenantRestoreJournalPublicationRetryErrorCode };
  }> = [];
  const ackInputs: TenantRestoreJournalAdapterResult[] = [];
  let ackResponseLosses = 0;
  let sealResponseLosses = 0;
  let renewAllowed = true;

  const authorized = (authorization: TenantRestoreJournalPublicationAuthorization): boolean => (
    phase === "queued"
    && claimed
    && authorization.requestId === REQUEST_ID
    && authorization.tenantId === TENANT_ID
    && authorization.subjectGeneration === 1
    && authorization.publicationGeneration === 1
    && authorization.claimAttempt === claimAttempt
    && authorization.claimToken === activeToken
  );
  const currentClaim = (): TenantRestoreJournalPublicationClaim => ({
    ...source,
    phase: "queued",
    claimAttempt,
    claimToken: activeToken!,
    leaseUntilMs: 100_000 + claimAttempt,
  });

  const materialize = vi.fn(async () => {
    trace.push("materialize");
    return 1;
  });
  const claimJobs = vi.fn(async (input: ClaimTenantRestoreJournalPublicationsOptions) => {
    trace.push("claim");
    if (phase !== "queued" || claimed) return [];
    claimed = true;
    claimAttempt += 1;
    activeToken = input.claimToken;
    return [currentClaim()];
  });
  const renew = vi.fn(async (authorization: TenantRestoreJournalPublicationAuthorization) => {
    trace.push("renew");
    return renewAllowed && authorized(authorization);
  });
  const retry = vi.fn(async (
    authorization: TenantRestoreJournalPublicationAuthorization,
    retryOptions: { delayMs: number; errorCode: TenantRestoreJournalPublicationRetryErrorCode },
  ) => {
    trace.push("retry");
    if (!authorized(authorization)) return false;
    retries.push({ authorization: structuredClone(authorization), options: retryOptions });
    claimed = false;
    activeToken = undefined;
    return true;
  });
  const block = vi.fn(async (
    authorization: TenantRestoreJournalPublicationAuthorization,
    reason: TenantRestoreJournalPublicationBlockReasonCode = "remote_conflict",
  ) => {
    trace.push("block");
    if (!authorized(authorization)) return false;
    blockReason = reason;
    phase = "blocked";
    claimed = false;
    return true;
  });
  const recordAck = vi.fn(async (
    authorization: TenantRestoreJournalPublicationAuthorization,
    result: TenantRestoreJournalAdapterResult,
  ) => {
    trace.push("ack");
    if (!authorized(authorization)) return null;
    ackInputs.push(structuredClone(result));
    const target = targets.find((candidate) => candidate.targetSha256 === result.targetSha256);
    if (!target) throw new TenantErasureIntegrityError();
    let ack = acks.find((candidate) => candidate.targetOrdinal === target.targetOrdinal);
    if (!ack) {
      const body = {
        requestId: REQUEST_ID,
        tenantId: TENANT_ID,
        subjectGeneration: 1,
        publicationGeneration: 1,
        scope: TENANT_RESTORE_JOURNAL_PUBLICATION_TARGET_ACK_SCOPE,
        targetOrdinal: target.targetOrdinal,
        targetSha256: target.targetSha256,
        failureDomainSha256: target.failureDomainSha256,
        targetReceiptSha256: target.receiptSha256,
        operationSha256: target.operationSha256,
        recordSha256: target.recordSha256,
        adapterProtocol: result.adapterProtocol,
        journalNamespaceSha256: result.journalNamespaceSha256,
        logicalDatabaseNamespaceSha256: result.logicalDatabaseNamespaceSha256,
        remoteSequence: result.remoteSequence,
        previousHeadRootSha256: result.previousHeadRootSha256,
        headRootSha256: result.headRootSha256,
        completedClaimAttempt: authorization.claimAttempt,
        completedClaimTokenSha256: tenantRestoreJournalClaimTokenSha256(
          authorization.claimToken,
        ),
        storeDbTimestampMs: 2_000 + authorization.claimAttempt,
      };
      ack = {
        ...body,
        receiptSha256: tenantRestoreJournalPublicationTargetAckSha256(body),
      };
      acks = [...acks, ack].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
    }
    if (ackResponseLosses > 0) {
      ackResponseLosses -= 1;
      throw new Error("unsafe ACK response included a database locator");
    }
    return structuredClone(ack);
  });
  const seal = vi.fn(async (authorization: TenantRestoreJournalPublicationAuthorization) => {
    trace.push("seal");
    if (phase === "published") {
      return authorization.claimAttempt === claimAttempt && authorization.claimToken === activeToken
        ? structuredClone(receipt!)
        : null;
    }
    if (!authorized(authorization) || acks.length !== targets.length) return null;
    const body = {
      ...source,
      scope: TENANT_RESTORE_JOURNAL_PUBLICATION_RECEIPT_SCOPE,
      targetAckCount: acks.length,
      targetAckRootSha256: tenantRestoreJournalPublicationTargetAckRootSha256(acks),
      remoteCommitCount: acks.length,
      remoteCommitRootSha256: tenantRestoreJournalRemoteCommitRootSha256(acks),
      completedClaimAttempt: authorization.claimAttempt,
      completedClaimTokenSha256: tenantRestoreJournalClaimTokenSha256(authorization.claimToken),
      storeDbTimestampMs: 3_000 + authorization.claimAttempt,
      restoreFencePublicationComplete: true as const,
      restoreFenceReplayComplete: false as const,
      physicalReplayComplete: false as const,
      allDomainsComplete: false as const,
      contentPurgeExecuted: false as const,
    };
    receipt = {
      ...body,
      receiptSha256: tenantRestoreJournalPublicationReceiptSha256(body),
    };
    phase = "published";
    claimed = false;
    if (sealResponseLosses > 0) {
      sealResponseLosses -= 1;
      throw new Error("unsafe seal response included a tenant identifier");
    }
    return structuredClone(receipt);
  });
  const getBundle = vi.fn(async () => ({
    targets: structuredClone(targets),
    targetAcks: structuredClone(acks),
    ...(receipt ? { receipt: structuredClone(receipt) } : {}),
  }));
  const getRecord = vi.fn(async (
    authorization: TenantRestoreJournalPublicationAuthorization,
    targetOrdinal: number,
  ) => authorized(authorization) && targets[targetOrdinal]
    ? { target: structuredClone(targets[targetOrdinal]!), record: structuredClone(record) }
    : null);
  const getControl = vi.fn(async () => structuredClone(control));
  const getCatalog = vi.fn(async () => structuredClone(catalog));
  const store: TenantRestoreJournalStore = {
    getTenantRestoreJournalControl: getControl,
    getTenantRestoreJournalControlTargets: getCatalog,
    activateTenantRestoreJournalControl: vi.fn(async () => structuredClone(control)),
    materializeTenantRestoreJournalPublicationJobs: materialize,
    claimTenantRestoreJournalPublications: claimJobs,
    renewTenantRestoreJournalPublication: renew,
    retryTenantRestoreJournalPublication: retry,
    blockTenantRestoreJournalPublication: block,
    getTenantRestoreJournalPublicationRecord: getRecord,
    recordTenantRestoreJournalPublicationTargetAck: recordAck,
    sealTenantRestoreJournalPublication: seal,
    getTenantRestoreJournalPublicationJob: vi.fn(async () => null),
    getTenantRestoreJournalPublicationBundle: getBundle,
    hasTenantRestoreJournalPublicationWork: vi.fn(async () => phase !== "published"),
  };
  const canExecute = vi.fn(async () => {
    trace.push("gate");
    return true;
  });

  return {
    adapters,
    delegates,
    inspectMethods,
    publishMethods,
    closeMethods,
    store,
    trace,
    canExecute,
    materialize,
    claimJobs,
    renew,
    retry,
    block,
    recordAck,
    seal,
    getBundle,
    getRecord,
    getControl,
    getCatalog,
    targets,
    record,
    catalog,
    ackInputs,
    retries,
    setAckResponseLosses: (count: number) => { ackResponseLosses = count; },
    setSealResponseLosses: (count: number) => { sealResponseLosses = count; },
    setRenewAllowed: (allowed: boolean) => { renewAllowed = allowed; },
    getPhase: () => phase,
    getBlockReason: () => blockReason,
    getAcks: () => structuredClone(acks),
  };
}

function expectFreshRenewBefore(trace: readonly string[], operation: string): void {
  const positions = trace
    .map((entry, index) => entry === operation ? index : -1)
    .filter((index) => index >= 0);
  expect(positions.length, operation).toBeGreaterThan(0);
  for (const position of positions) {
    expect(trace[position - 1], operation).toBe("renew");
    expect(trace[position - 2], operation).toBe("gate");
  }
}

describe("TenantRestoreJournalPublicationWorker", () => {
  it("publishes every ordered target and seals only after strict ACK convergence", async () => {
    const state = fixture({ targetCount: 2 });
    const worker = new TenantRestoreJournalPublicationWorker({
      store: state.store,
      adapters: state.adapters,
      canExecute: state.canExecute,
    }, { leaseMs: 500, batchSize: 3, materializeBatchSize: 7 });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.materialize).toHaveBeenCalledWith({ limit: 7 });
    expect(state.claimJobs).toHaveBeenCalledWith(expect.objectContaining({
      limit: 3,
      leaseMs: 500,
    }));
    expect(state.publishMethods[0]).toHaveBeenCalledOnce();
    expect(state.publishMethods[1]).toHaveBeenCalledOnce();
    expect(state.recordAck).toHaveBeenCalledTimes(2);
    expect(state.getAcks()).toHaveLength(2);
    expect(state.seal).toHaveBeenCalledOnce();
    expect(state.getPhase()).toBe("published");
    for (const operation of ["inspect:0", "publish:0", "ack", "inspect:1", "publish:1", "seal"]) {
      expectFreshRenewBefore(state.trace, operation);
    }
    expect(state.trace.indexOf("ack")).toBeLessThan(state.trace.lastIndexOf("seal"));
  });

  it("serializes concurrent workers through one lease and honors a lost renewal", async () => {
    const concurrent = fixture({ targetCount: 1 });
    const first = new TenantRestoreJournalPublicationWorker({
      store: concurrent.store,
      adapters: concurrent.adapters,
      canExecute: concurrent.canExecute,
    });
    const second = new TenantRestoreJournalPublicationWorker({
      store: concurrent.store,
      adapters: concurrent.adapters,
      canExecute: concurrent.canExecute,
    });
    const results = await Promise.all([first.processOnce(), second.processOnce()]);
    expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(concurrent.publishMethods[0]).toHaveBeenCalledOnce();
    expect(concurrent.recordAck).toHaveBeenCalledOnce();

    const expired = fixture({ targetCount: 1 });
    expired.setRenewAllowed(false);
    const expiredWorker = new TenantRestoreJournalPublicationWorker({
      store: expired.store,
      adapters: expired.adapters,
      canExecute: expired.canExecute,
    });
    await expect(expiredWorker.processOnce()).resolves.toBe(0);
    expect(expired.inspectMethods[0]).not.toHaveBeenCalled();
    expect(expired.publishMethods[0]).not.toHaveBeenCalled();
    expect(expired.retry).toHaveBeenCalledOnce();
  });

  it("fails closed when a fresh gate closes before the first remote boundary", async () => {
    const state = fixture({ targetCount: 1 });
    const gates = [true, true, true, false];
    const worker = new TenantRestoreJournalPublicationWorker({
      store: state.store,
      adapters: state.adapters,
      canExecute: vi.fn(async () => gates.shift() ?? false),
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.inspectMethods[0]).not.toHaveBeenCalled();
    expect(state.publishMethods[0]).not.toHaveBeenCalled();
    expect(state.recordAck).not.toHaveBeenCalled();
    expect(state.retry).toHaveBeenCalledOnce();
  });

  it("repairs a committed publish response loss by exact inspect without publishing twice", async () => {
    const state = fixture({ targetCount: 1 });
    const originalPublish = state.publishMethods[0]!.getMockImplementation()!;
    state.publishMethods[0]!.mockImplementationOnce(async (record) => {
      await originalPublish(record);
      throw new Error("unsafe response loss with bucket locator");
    });
    const worker = new TenantRestoreJournalPublicationWorker({
      store: state.store,
      adapters: state.adapters,
      canExecute: state.canExecute,
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.publishMethods[0]).toHaveBeenCalledOnce();
    expect(state.inspectMethods[0]).toHaveBeenCalledTimes(2);
    expect(state.recordAck).toHaveBeenCalledOnce();
    await expect(state.delegates[0]!.readHead()).resolves.toMatchObject({ remoteSequence: 1 });
  });

  it("leaves an orphan unacknowledged, then links it exactly on the next claim", async () => {
    const state = fixture({ targetCount: 1, orphanTargetOrdinal: 0 });
    const worker = new TenantRestoreJournalPublicationWorker({
      store: state.store,
      adapters: state.adapters,
      canExecute: state.canExecute,
    }, { retryBaseMs: 10, retryMaxMs: 100 });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.recordAck).not.toHaveBeenCalled();
    expect(state.retry).toHaveBeenCalledOnce();
    await expect(state.delegates[0]!.readHead()).resolves.toMatchObject({ remoteSequence: 0 });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.publishMethods[0]).toHaveBeenCalledTimes(2);
    expect(state.recordAck).toHaveBeenCalledOnce();
    await expect(state.delegates[0]!.readHead()).resolves.toMatchObject({ remoteSequence: 1 });
  });

  it("replays exact ACK and terminal seal inputs after committed response loss", async () => {
    const state = fixture({ targetCount: 1 });
    state.setAckResponseLosses(1);
    state.setSealResponseLosses(1);
    const worker = new TenantRestoreJournalPublicationWorker({
      store: state.store,
      adapters: state.adapters,
      canExecute: state.canExecute,
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.recordAck).toHaveBeenCalledTimes(2);
    expect(state.ackInputs).toHaveLength(2);
    expect(state.ackInputs[1]).toEqual(state.ackInputs[0]);
    expect(state.seal).toHaveBeenCalledTimes(2);
    expect(state.seal.mock.calls[1]).toEqual(state.seal.mock.calls[0]);
    expect(state.retry).not.toHaveBeenCalled();
  });

  it("blocks remote corruption permanently and never logs raw errors or identities", async () => {
    const state = fixture({ targetCount: 1 });
    state.inspectMethods[0]!.mockRejectedValue(
      new TenantRestoreJournalCorruptError("chain"),
    );
    const warn = vi.fn();
    const worker = new TenantRestoreJournalPublicationWorker({
      store: state.store,
      adapters: state.adapters,
      canExecute: state.canExecute,
      logger: { warn },
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.block).toHaveBeenCalledOnce();
    expect(state.getBlockReason()).toBe("remote_conflict");
    expect(state.retry).not.toHaveBeenCalled();
    const logs = JSON.stringify(warn.mock.calls);
    expect(logs).not.toContain(TENANT_ID);
    expect(logs).not.toContain("chain is corrupt");
    expect(logs).not.toContain("publication-worker-target");
  });

  it("blocks source/catalog drift and exponentially retries transient failures", async () => {
    const drift = fixture({ targetCount: 1 });
    drift.getCatalog.mockResolvedValue([{ ...drift.catalog[0]!, targetSha256: "f".repeat(64) }]);
    const driftWorker = new TenantRestoreJournalPublicationWorker({
      store: drift.store,
      adapters: drift.adapters,
      canExecute: drift.canExecute,
    });
    await expect(driftWorker.processOnce()).resolves.toBe(0);
    expect(drift.getBlockReason()).toBe("source_conflict");
    expect(drift.publishMethods[0]).not.toHaveBeenCalled();

    const temporary = fixture({ targetCount: 1, initialClaimAttempt: 1 });
    temporary.inspectMethods[0]!.mockRejectedValue(
      new Error("unsafe temporary error containing endpoint and tenant"),
    );
    const retryWorker = new TenantRestoreJournalPublicationWorker({
      store: temporary.store,
      adapters: temporary.adapters,
      canExecute: temporary.canExecute,
    }, { retryBaseMs: 10, retryMaxMs: 100 });
    await expect(retryWorker.processOnce()).resolves.toBe(0);
    expect(temporary.retries).toHaveLength(1);
    expect(temporary.retries[0]!.options).toEqual({
      delayMs: 20,
      errorCode: "temporary_failure",
    });
    expect(temporary.block).not.toHaveBeenCalled();
  });

  it("retries a forward predecessor dependency without blocking its source", async () => {
    const state = fixture({ targetCount: 1 });
    state.recordAck.mockRejectedValueOnce(
      new TenantRestoreJournalPublicationDependencyPendingError(),
    );
    const worker = new TenantRestoreJournalPublicationWorker({
      store: state.store,
      adapters: state.adapters,
      canExecute: state.canExecute,
    }, { retryBaseMs: 10, retryMaxMs: 100 });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.retries).toHaveLength(1);
    expect(state.retries[0]!.options).toEqual({
      delayMs: 10,
      errorCode: "dependency_pending",
    });
    expect(state.block).not.toHaveBeenCalled();
    expect(state.getPhase()).toBe("queued");
  });

  it("converges three workers after external appends ACK in reverse order", async () => {
    let nowMs = 50_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const logicalDatabaseNamespaceSha256 =
      tenantRestoreLogicalDatabaseNamespaceSha256("publication-worker-interleaving");
    const adapter = new MemoryTenantRestoreJournalAdapter({
      nonProductionFixture: true,
      namespaceId: "publication-worker-interleaving",
      failureDomainId: "publication-worker-interleaving-domain",
      targetId: "publication-worker-interleaving-target",
      logicalDatabaseNamespaceSha256,
    });
    const descriptor: TenantRestoreJournalTargetDescriptor = {
      targetOrdinal: 0,
      targetSha256: adapter.targetSha256,
      failureDomainSha256: adapter.failureDomainSha256,
      adapterProtocol: adapter.adapterProtocol,
      journalNamespaceSha256: adapter.journalNamespaceSha256,
    };
    await store.activateTenantRestoreJournalControl({
      adapterProtocol: descriptor.adapterProtocol,
      journalNamespaceSha256: descriptor.journalNamespaceSha256,
      logicalDatabaseNamespaceSha256,
      runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("publication-worker-interleaving"),
      targets: [descriptor],
      observedHeads: [{
        ...descriptor,
        logicalDatabaseNamespaceSha256,
        sealedRemoteSequence: 0,
        sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
      }],
    });
    const inputs = Array.from({ length: 3 }, (_value, index) => {
      const tenantId = `tenant-worker-interleaving-${index + 1}`;
      return {
        requestId: newErasureRequestId(),
        tenantId,
        requestedByKeyId: "publication-worker-interleaving",
        idempotencyKey: `publication-worker-interleaving-${index + 1}`,
        requestHash: tenantErasureRequestHash(tenantId),
        atMs: nowMs,
      };
    });
    for (const input of inputs) {
      await store.setTenantAuth(input.tenantId, DEFAULT_AUTH_POLICY);
      await store.requestTenantErasure(input);
    }

    const firstAckEntered = deferred<void>();
    const secondAckEntered = deferred<void>();
    const releaseFirstAck = deferred<void>();
    const releaseSecondAck = deferred<void>();
    const workerStore = new Proxy(store as TenantRestoreJournalStore, {
      get(target, property, receiver) {
        if (property === "recordTenantRestoreJournalPublicationTargetAck") {
          return async (
            authorization: TenantRestoreJournalPublicationAuthorization,
            result: TenantRestoreJournalAdapterResult,
          ) => {
            if (result.remoteSequence === 1) {
              firstAckEntered.resolve(undefined);
              await releaseFirstAck.promise;
            } else if (result.remoteSequence === 2) {
              secondAckEntered.resolve(undefined);
              await releaseSecondAck.promise;
            }
            return store.recordTenantRestoreJournalPublicationTargetAck(
              authorization,
              result,
            );
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const workers = Array.from({ length: 3 }, () => (
      new TenantRestoreJournalPublicationWorker({
        store: workerStore,
        adapters: [adapter],
        canExecute: async () => true,
      }, {
        batchSize: 1,
        materializeBatchSize: 10,
        leaseMs: 10_000,
        retryBaseMs: 1,
        retryMaxMs: 8,
      })
    ));

    const firstRun = workers[0]!.processOnce();
    await firstAckEntered.promise;
    const secondRun = workers[1]!.processOnce();
    await secondAckEntered.promise;
    const thirdRun = workers[2]!.processOnce();
    await expect(thirdRun).resolves.toBe(0);
    releaseSecondAck.resolve(undefined);
    await expect(secondRun).resolves.toBe(0);
    releaseFirstAck.resolve(undefined);
    await expect(firstRun).resolves.toBe(1);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      nowMs += 100;
      await workers[attempt % workers.length]!.processOnce();
      const jobs = await Promise.all(inputs.map((input) => (
        store.getTenantRestoreJournalPublicationJob(input.tenantId, input.requestId)
      )));
      if (jobs.every((job) => job?.phase === "published")) break;
    }

    const jobs = await Promise.all(inputs.map((input) => (
      store.getTenantRestoreJournalPublicationJob(input.tenantId, input.requestId)
    )));
    expect(jobs).toHaveLength(3);
    expect(jobs.map((job) => job?.phase)).toEqual([
      "published",
      "published",
      "published",
    ]);
    expect(await store.getTenantRestoreRuntimeHeads()).toMatchObject([{
      sealedRemoteSequence: 3,
    }]);
    expect(store.tenantRestoreJournalPublicationTargetAcks.size).toBe(3);
  });

  it("distinguishes a cross-owner record from a mismatched remote adapter result", async () => {
    const sourceDrift = fixture({ targetCount: 1 });
    sourceDrift.getRecord.mockResolvedValue({
      target: structuredClone(sourceDrift.targets[0]!),
      record: { ...sourceDrift.record, tenantId: "tenant-cross-owner" },
    });
    const sourceWorker = new TenantRestoreJournalPublicationWorker({
      store: sourceDrift.store,
      adapters: sourceDrift.adapters,
      canExecute: sourceDrift.canExecute,
    });
    await expect(sourceWorker.processOnce()).resolves.toBe(0);
    expect(sourceDrift.getBlockReason()).toBe("source_conflict");
    expect(sourceDrift.publishMethods[0]).not.toHaveBeenCalled();

    const remoteDrift = fixture({ targetCount: 2 });
    const foreign = await remoteDrift.delegates[1]!.publishRecord(remoteDrift.record);
    remoteDrift.inspectMethods[0]!.mockResolvedValue({ ...foreign, replayed: true });
    const remoteWorker = new TenantRestoreJournalPublicationWorker({
      store: remoteDrift.store,
      adapters: remoteDrift.adapters,
      canExecute: remoteDrift.canExecute,
    });
    await expect(remoteWorker.processOnce()).resolves.toBe(0);
    expect(remoteDrift.getBlockReason()).toBe("remote_conflict");
    expect(remoteDrift.publishMethods[0]).not.toHaveBeenCalled();
  });

  it("stop revokes new boundaries, waits for in-flight publication, and closes every adapter", async () => {
    const state = fixture({ targetCount: 1 });
    const release = deferred<void>();
    const originalPublish = state.publishMethods[0]!.getMockImplementation()!;
    state.publishMethods[0]!.mockImplementationOnce(async (record) => {
      await release.promise;
      return originalPublish(record);
    });
    const worker = new TenantRestoreJournalPublicationWorker({
      store: state.store,
      adapters: state.adapters,
      canExecute: state.canExecute,
    }, { pollIntervalMs: 10 });

    worker.start();
    await vi.waitFor(() => expect(state.publishMethods[0]).toHaveBeenCalledOnce());
    let stopped = false;
    const stopPromise = worker.stop();
    expect(worker.stop()).toBe(stopPromise);
    expect(() => worker.start()).toThrow("worker is closed");
    const stopping = stopPromise.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await stopping;
    expect(() => worker.start()).toThrow("worker is closed");

    expect(state.recordAck).not.toHaveBeenCalled();
    expect(state.seal).not.toHaveBeenCalled();
    expect(state.retry).not.toHaveBeenCalled();
    expect(state.closeMethods[0]).toHaveBeenCalledOnce();
  });

  it("rejects unsafe worker bounds and incoherent adapter catalogs", () => {
    const state = fixture({ targetCount: 1 });
    expect(() => new TenantRestoreJournalPublicationWorker({
      store: state.store,
      adapters: state.adapters,
      canExecute: state.canExecute,
    }, { batchSize: 101 })).toThrow("must not exceed 100");
    expect(() => new TenantRestoreJournalPublicationWorker({
      store: state.store,
      adapters: state.adapters,
      canExecute: state.canExecute,
    }, { retryBaseMs: 10, retryMaxMs: 9 })).toThrow("must be >=");
    expect(() => new TenantRestoreJournalPublicationWorker({
      store: state.store,
      adapters: [],
      canExecute: state.canExecute,
    })).toThrow("between one and 32");
  });
});
