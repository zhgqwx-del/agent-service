import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  EMPTY_TENANT_RESTORE_RUNTIME_CONTROL_EVIDENCE_SHA256,
  MEMORY_TENANT_RESTORE_JOURNAL_PROTOCOL,
  TENANT_RESTORE_JOURNAL_CONTROL_SINGLETON_ID,
  TENANT_RESTORE_JOURNAL_PROTOCOL,
  TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
  TENANT_RESTORE_RUNTIME_CONTROL_SINGLETON_ID,
  MemoryTenantRestoreJournalAdapter,
  MemorySessionStore,
  tenantRestoreJournalControlEvidenceSha256,
  tenantRestoreJournalOperationSha256,
  tenantRestoreJournalRecordSha256,
  tenantRestoreJournalTargetRootSha256,
  tenantRestoreLogicalDatabaseNamespaceSha256,
  tenantRestoreReplaySealedTargetRootSha256,
  tenantRestoreRuntimeControlEvidenceSha256,
  tenantRestoreRuntimeEpochSha256,
  type AssertTenantRestoreRuntimeJournalEntryKnownInput,
  type AssertTenantRestoreRuntimeReadyInput,
  type TenantRestoreJournalControlRecord,
  type TenantRestoreJournalRecord,
  type TenantRestoreJournalRemoteEntry,
  type TenantRestoreJournalRemoteHead,
  type TenantRestoreJournalTargetDescriptor,
  type TenantRestoreReplaySealedTarget,
  type TenantRestoreRuntimeControlRecord,
} from "@agent-service/store";
import {
  TenantRestoreJournalPreflightError,
  reconcileTenantRestoreJournalRuntimeForStartup,
  type TenantRestoreJournalPreflightAdapter,
  type TenantRestoreJournalPreflightConfig,
  type TenantRestoreJournalPreflightStore,
} from "../src/tenant-restore-journal-preflight.js";

const LOGICAL_DATABASE_NAMESPACE_SHA256 = tenantRestoreLogicalDatabaseNamespaceSha256(
  "preflight-logical-database-v1",
);
const RUNTIME_EPOCH_SHA256 = tenantRestoreRuntimeEpochSha256("preflight-runtime-epoch-v1");

function record(index: number): TenantRestoreJournalRecord {
  const suffix = String(index).padStart(12, "0");
  const requestId = `erase_00000000-0000-4000-8000-${suffix}`;
  const tenantId = `tenant-preflight-${index}`;
  const t1FenceSha256 = index.toString(16).padStart(64, "0");
  const operationSha256 = tenantRestoreJournalOperationSha256({
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    requestId,
    tenantId,
    subjectGeneration: 1,
    t1FenceSha256,
  });
  const body = {
    scope: TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
    protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    requestId,
    tenantId,
    subjectGeneration: 1,
    t1FenceSha256,
    operationSha256,
  } as const;
  return { ...body, recordSha256: tenantRestoreJournalRecordSha256(body) };
}

function sameEntry(left: TenantRestoreJournalRemoteEntry, right: TenantRestoreJournalRemoteEntry) {
  return left.targetSha256 === right.targetSha256
    && left.remoteSequence === right.remoteSequence
    && left.previousHeadRootSha256 === right.previousHeadRootSha256
    && left.headRootSha256 === right.headRootSha256
    && left.record.recordSha256 === right.record.recordSha256;
}

interface HarnessOptions {
  recordCount?: number;
  checkpointSequence?: number;
  localKnownSequences?: readonly number[];
  journalActive?: boolean;
  runtimeActive?: boolean;
  checkpointRootOverride?: string;
  externalHeadOverride?: TenantRestoreJournalRemoteHead;
  startupError?: boolean;
  responseLossAfterConcurrentAdvance?: boolean;
  appendAfterFirstReady?: boolean;
  catalogOverride?: TenantRestoreJournalTargetDescriptor[];
}

async function harness(options: HarnessOptions = {}) {
  const delegate = new MemoryTenantRestoreJournalAdapter({
    nonProductionFixture: true,
    namespaceId: "preflight-journal-v1",
    failureDomainId: "preflight-failure-domain-v1",
    targetId: "preflight-target-v1",
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
  });
  const remoteEntries: TenantRestoreJournalRemoteEntry[] = [];
  for (let index = 1; index <= (options.recordCount ?? 0); index += 1) {
    remoteEntries.push(await delegate.publishRecord(record(index)));
  }
  const validateStartup = vi.fn(async () => {
    if (options.startupError) {
      throw new Error("unsafe startup failure with bucket and credential locator");
    }
  });
  const readHead = vi.fn(async () => options.externalHeadOverride
    ?? delegate.readHead());
  const scanRecords = vi.fn((input: Parameters<typeof delegate.scanRecords>[0]) => (
    delegate.scanRecords(input)
  ));
  const adapter: TenantRestoreJournalPreflightAdapter = {
    adapterProtocol: delegate.adapterProtocol,
    journalNamespaceSha256: delegate.journalNamespaceSha256,
    targetSha256: delegate.targetSha256,
    failureDomainSha256: delegate.failureDomainSha256,
    logicalDatabaseNamespaceSha256: delegate.logicalDatabaseNamespaceSha256,
    validateStartup,
    publishRecord: (value) => delegate.publishRecord(value),
    inspectRecord: (value) => delegate.inspectRecord(value),
    readHead,
    scanRecords,
    close: () => delegate.close(),
  };
  const descriptor: TenantRestoreJournalTargetDescriptor = {
    targetOrdinal: 0,
    targetSha256: adapter.targetSha256,
    failureDomainSha256: adapter.failureDomainSha256,
    adapterProtocol: adapter.adapterProtocol,
    journalNamespaceSha256: adapter.journalNamespaceSha256,
  };
  const targetRootSha256 = tenantRestoreJournalTargetRootSha256([descriptor]);
  const config: TenantRestoreJournalPreflightConfig = {
    adapterProtocol: adapter.adapterProtocol,
    journalNamespaceSha256: adapter.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    runtimeEpochSha256: RUNTIME_EPOCH_SHA256,
    targetRootSha256,
    targets: [{ descriptor }],
  };
  const activeControlBody = {
    singletonId: TENANT_RESTORE_JOURNAL_CONTROL_SINGLETON_ID,
    controlGeneration: 1 as const,
    activatedAtDbMs: 1_000,
    protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
    adapterProtocol: MEMORY_TENANT_RESTORE_JOURNAL_PROTOCOL,
    journalNamespaceSha256: adapter.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    targetCount: 1,
    targetRootSha256,
  };
  const activeControl: Extract<TenantRestoreJournalControlRecord, { controlGeneration: 1 }> = {
    ...activeControlBody,
    evidenceSha256: tenantRestoreJournalControlEvidenceSha256(activeControlBody),
  };
  const exposedControl: TenantRestoreJournalControlRecord = options.journalActive === false
    ? {
        singletonId: TENANT_RESTORE_JOURNAL_CONTROL_SINGLETON_ID,
        controlGeneration: 0,
      }
    : activeControl;
  const checkpointSequence = options.checkpointSequence ?? 0;
  const checkpointEntry = checkpointSequence === 0
    ? undefined
    : remoteEntries[checkpointSequence - 1];
  const checkpoint: TenantRestoreReplaySealedTarget = {
    ...descriptor,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    sealedRemoteSequence: checkpointSequence,
    sealedHeadRootSha256: options.checkpointRootOverride
      ?? checkpointEntry?.headRootSha256
      ?? EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  };
  let runtimeHeads = [checkpoint];
  const initialRuntimeBody = {
    singletonId: TENANT_RESTORE_RUNTIME_CONTROL_SINGLETON_ID,
    state: "active" as const,
    controlGeneration: 1,
    updateKind: "primary_activation" as const,
    activatedAtDbMs: 1_000,
    updatedAtDbMs: 1_000,
    lineageKind: "primary" as const,
    runtimeEpochSha256: RUNTIME_EPOCH_SHA256,
    controlEvidenceSha256: activeControl.evidenceSha256,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    targetCount: 1,
    targetRootSha256,
    verifiedHeadRootSha256: tenantRestoreReplaySealedTargetRootSha256(runtimeHeads),
    previousControlEvidenceSha256: EMPTY_TENANT_RESTORE_RUNTIME_CONTROL_EVIDENCE_SHA256,
  };
  let runtime: TenantRestoreRuntimeControlRecord = options.runtimeActive === false
    ? {
        singletonId: TENANT_RESTORE_RUNTIME_CONTROL_SINGLETON_ID,
        state: "inactive",
        controlGeneration: 0,
      }
    : {
        ...initialRuntimeBody,
        evidenceSha256: tenantRestoreRuntimeControlEvidenceSha256(initialRuntimeBody),
      };
  const durableKnown = new Map<number, TenantRestoreJournalRemoteEntry>();
  for (const entry of remoteEntries.slice(0, checkpointSequence)) {
    durableKnown.set(entry.remoteSequence, structuredClone(entry));
  }
  const locallyKnown = new Set(options.localKnownSequences
    ?? remoteEntries.map((entry) => entry.remoteSequence));
  let injectResponseLoss = options.responseLossAfterConcurrentAdvance === true;
  let appendAfterReady = options.appendAfterFirstReady === true;

  const advance = (entry: TenantRestoreJournalRemoteEntry): void => {
    if (runtime.state !== "active") throw new Error("runtime inactive");
    const currentHead = runtimeHeads[0]!;
    if (entry.remoteSequence !== currentHead.sealedRemoteSequence + 1
      || entry.previousHeadRootSha256 !== currentHead.sealedHeadRootSha256
      || !locallyKnown.has(entry.remoteSequence)) {
      throw new Error("unknown entry");
    }
    durableKnown.set(entry.remoteSequence, structuredClone(entry));
    runtimeHeads = [{
      ...currentHead,
      sealedRemoteSequence: entry.remoteSequence,
      sealedHeadRootSha256: entry.headRootSha256,
    }];
    const body = {
      singletonId: TENANT_RESTORE_RUNTIME_CONTROL_SINGLETON_ID,
      state: "active" as const,
      controlGeneration: runtime.controlGeneration + 1,
      updateKind: "journal_head_advance" as const,
      activatedAtDbMs: runtime.activatedAtDbMs,
      updatedAtDbMs: runtime.updatedAtDbMs + 1,
      lineageKind: "primary" as const,
      runtimeEpochSha256: runtime.runtimeEpochSha256,
      controlEvidenceSha256: runtime.controlEvidenceSha256,
      logicalDatabaseNamespaceSha256: runtime.logicalDatabaseNamespaceSha256,
      targetCount: runtime.targetCount,
      targetRootSha256: runtime.targetRootSha256,
      verifiedHeadRootSha256: tenantRestoreReplaySealedTargetRootSha256(runtimeHeads),
      previousControlEvidenceSha256: runtime.evidenceSha256,
    };
    runtime = { ...body, evidenceSha256: tenantRestoreRuntimeControlEvidenceSha256(body) };
  };

  const assertKnown = vi.fn(async (input: AssertTenantRestoreRuntimeJournalEntryKnownInput) => {
    if (runtime.state !== "active") throw new Error("runtime inactive");
    if (injectResponseLoss) {
      injectResponseLoss = false;
      advance(input.remoteEntry);
      throw new Error("unsafe lost response containing tenant and physical locator");
    }
    const existing = durableKnown.get(input.remoteEntry.remoteSequence);
    if (existing) {
      if (!sameEntry(existing, input.remoteEntry)) throw new Error("conflicting exact replay");
      return structuredClone(runtime);
    }
    if (input.runtimeEpochSha256 !== RUNTIME_EPOCH_SHA256
      || input.controlEvidenceSha256 !== activeControl.evidenceSha256
      || input.expectedControlGeneration !== runtime.controlGeneration
      || input.targetOrdinal !== 0) {
      throw new Error("stale runtime authorization");
    }
    advance(input.remoteEntry);
    return structuredClone(runtime);
  });
  const assertReady = vi.fn(async (input: AssertTenantRestoreRuntimeReadyInput) => {
    if (runtime.state !== "active"
      || input.runtimeEpochSha256 !== runtime.runtimeEpochSha256
      || input.controlEvidenceSha256 !== runtime.controlEvidenceSha256
      || input.observedHeads.length !== runtimeHeads.length
      || input.observedHeads.some((head, index) => (
        head.sealedRemoteSequence !== runtimeHeads[index]!.sealedRemoteSequence
        || head.sealedHeadRootSha256 !== runtimeHeads[index]!.sealedHeadRootSha256
      ))) throw new Error("runtime is not ready");
    if (appendAfterReady) {
      appendAfterReady = false;
      const entry = await delegate.publishRecord(record(remoteEntries.length + 1));
      remoteEntries.push(entry);
      locallyKnown.add(entry.remoteSequence);
    }
  });
  const store: TenantRestoreJournalPreflightStore = {
    getTenantRestoreJournalControl: vi.fn(async () => structuredClone(exposedControl)),
    getTenantRestoreJournalControlTargets: vi.fn(async () => structuredClone(
      options.catalogOverride ?? [descriptor],
    )),
    getTenantRestoreRuntimeControl: vi.fn(async () => structuredClone(runtime)),
    getTenantRestoreRuntimeHeads: vi.fn(async () => structuredClone(runtimeHeads)),
    assertTenantRestoreRuntimeJournalEntryKnown: assertKnown,
    assertTenantRestoreRuntimeReady: assertReady,
  };
  return {
    adapter,
    delegate,
    validateStartup,
    readHead,
    scanRecords,
    descriptor,
    config,
    activeControl,
    store,
    assertKnown,
    assertReady,
    remoteEntries,
    getRuntime: () => structuredClone(runtime),
    getRuntimeHeads: () => structuredClone(runtimeHeads),
  };
}

function expectCode(code: string) {
  return expect.objectContaining({
    name: "TenantRestoreJournalPreflightError",
    code,
  });
}

describe("tenant restore journal startup preflight", () => {
  it("keeps an unconfigured inactive journal dormant", async () => {
    const state = await harness({ journalActive: false, runtimeActive: false });
    await expect(reconcileTenantRestoreJournalRuntimeForStartup({
      store: state.store,
    })).resolves.toEqual({
      state: "inactive",
      configured: false,
      targetCount: 0,
      observedRecordCount: 0,
      verifiedRecordCount: 0,
      runtimeControlGeneration: 0,
    });
    expect(state.validateStartup).not.toHaveBeenCalled();
  });

  it("validates an empty configured adapter while journal control is inactive", async () => {
    const state = await harness({
      journalActive: false,
      runtimeActive: false,
    });
    const summary = await reconcileTenantRestoreJournalRuntimeForStartup({
      store: state.store,
      config: state.config,
      adapters: [state.adapter],
    });
    expect(summary).toEqual({
      state: "inactive",
      configured: true,
      targetCount: 1,
      observedRecordCount: 0,
      verifiedRecordCount: 0,
      runtimeControlGeneration: 0,
    });
    expect(state.validateStartup).toHaveBeenCalledOnce();
    expect(state.readHead).toHaveBeenCalledOnce();
    expect(state.assertKnown).not.toHaveBeenCalled();
    expect(state.assertReady).not.toHaveBeenCalled();
  });

  it("fails closed when the database rolls back before activation but the journal retains data", async () => {
    const state = await harness({
      journalActive: false,
      runtimeActive: false,
      recordCount: 1,
    });
    let failure: unknown;
    try {
      await reconcileTenantRestoreJournalRuntimeForStartup({
        store: state.store,
        config: state.config,
        adapters: [state.adapter],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(expectCode("remote_chain_conflict"));
    expect(String(failure)).not.toContain("tenant-preflight-1");
    expect(state.validateStartup).toHaveBeenCalledOnce();
    expect(state.readHead).toHaveBeenCalledOnce();
    expect(state.assertKnown).not.toHaveBeenCalled();
    expect(state.assertReady).not.toHaveBeenCalled();
  });

  it("observes a concurrent primary activation instead of returning a stale inactive result", async () => {
    const state = await harness();
    const activeRuntime = state.getRuntime();
    const inactiveControl: TenantRestoreJournalControlRecord = {
      singletonId: TENANT_RESTORE_JOURNAL_CONTROL_SINGLETON_ID,
      controlGeneration: 0,
    };
    const inactiveRuntime: TenantRestoreRuntimeControlRecord = {
      singletonId: TENANT_RESTORE_RUNTIME_CONTROL_SINGLETON_ID,
      state: "inactive",
      controlGeneration: 0,
    };
    const getControl = vi.mocked(state.store.getTenantRestoreJournalControl);
    const getRuntime = vi.mocked(state.store.getTenantRestoreRuntimeControl);
    getControl.mockReset();
    getControl
      .mockResolvedValueOnce(structuredClone(inactiveControl))
      .mockResolvedValueOnce(structuredClone(inactiveControl))
      .mockResolvedValue(structuredClone(state.activeControl));
    getRuntime.mockReset();
    getRuntime
      .mockResolvedValueOnce(structuredClone(inactiveRuntime))
      .mockResolvedValue(structuredClone(activeRuntime));

    await expect(reconcileTenantRestoreJournalRuntimeForStartup({
      store: state.store,
      config: state.config,
      adapters: [state.adapter],
    })).resolves.toMatchObject({
      state: "ready",
      observedRecordCount: 0,
      runtimeControlGeneration: 1,
    });
    expect(getControl.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(state.assertReady).toHaveBeenCalledOnce();
  });

  it("proves an old checkpoint is an ancestor, scans pages, and advances only known entries", async () => {
    const state = await harness({ recordCount: 3, checkpointSequence: 1 });
    const summary = await reconcileTenantRestoreJournalRuntimeForStartup({
      store: state.store,
      config: state.config,
      adapters: [state.adapter],
      scanPageSize: 1,
    });
    expect(summary).toEqual({
      state: "ready",
      configured: true,
      targetCount: 1,
      observedRecordCount: 3,
      verifiedRecordCount: 2,
      runtimeControlGeneration: 3,
    });
    expect(state.scanRecords).toHaveBeenCalledTimes(2);
    expect(state.scanRecords.mock.calls[0]![0]).toMatchObject({
      afterRemoteSequence: 1,
      afterHeadRootSha256: state.remoteEntries[0]!.headRootSha256,
      limit: 1,
    });
    expect(state.assertKnown).toHaveBeenCalledTimes(2);
    expect(state.assertReady).toHaveBeenCalledOnce();
    expect(state.getRuntimeHeads()[0]).toMatchObject({
      sealedRemoteSequence: 3,
      sealedHeadRootSha256: state.remoteEntries[2]!.headRootSha256,
    });
  });

  it("rechecks external heads after durable ready and reconciles a concurrent append", async () => {
    const state = await harness({ appendAfterFirstReady: true });
    await expect(reconcileTenantRestoreJournalRuntimeForStartup({
      store: state.store,
      config: state.config,
      adapters: [state.adapter],
    })).resolves.toEqual({
      state: "ready",
      configured: true,
      targetCount: 1,
      observedRecordCount: 1,
      verifiedRecordCount: 1,
      runtimeControlGeneration: 2,
    });
    expect(state.assertReady).toHaveBeenCalledTimes(2);
    expect(state.assertKnown).toHaveBeenCalledOnce();
    expect(state.readHead.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(state.getRuntimeHeads()[0]).toMatchObject({
      sealedRemoteSequence: 1,
      sealedHeadRootSha256: state.remoteEntries[0]!.headRootSha256,
    });
  });

  it("runs against the real MemorySessionStore primary runtime contract", async () => {
    const store = new MemorySessionStore();
    const delegate = new MemoryTenantRestoreJournalAdapter({
      nonProductionFixture: true,
      namespaceId: "preflight-real-store-journal-v1",
      failureDomainId: "preflight-real-store-domain-v1",
      targetId: "preflight-real-store-target-v1",
      logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    });
    const validateStartup = vi.fn(async () => undefined);
    const adapter: TenantRestoreJournalPreflightAdapter = {
      adapterProtocol: delegate.adapterProtocol,
      journalNamespaceSha256: delegate.journalNamespaceSha256,
      targetSha256: delegate.targetSha256,
      failureDomainSha256: delegate.failureDomainSha256,
      logicalDatabaseNamespaceSha256: delegate.logicalDatabaseNamespaceSha256,
      validateStartup,
      publishRecord: (value) => delegate.publishRecord(value),
      inspectRecord: (value) => delegate.inspectRecord(value),
      readHead: () => delegate.readHead(),
      scanRecords: (input) => delegate.scanRecords(input),
      close: () => delegate.close(),
    };
    const descriptor: TenantRestoreJournalTargetDescriptor = {
      targetOrdinal: 0,
      targetSha256: adapter.targetSha256,
      failureDomainSha256: adapter.failureDomainSha256,
      adapterProtocol: adapter.adapterProtocol,
      journalNamespaceSha256: adapter.journalNamespaceSha256,
    };
    const head = await adapter.readHead();
    const observedHeads: TenantRestoreReplaySealedTarget[] = [{
      ...descriptor,
      logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
      sealedRemoteSequence: head.remoteSequence,
      sealedHeadRootSha256: head.headRootSha256,
    }];
    const targetRootSha256 = tenantRestoreJournalTargetRootSha256([descriptor]);
    const config: TenantRestoreJournalPreflightConfig = {
      adapterProtocol: adapter.adapterProtocol,
      journalNamespaceSha256: adapter.journalNamespaceSha256,
      logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
      runtimeEpochSha256: RUNTIME_EPOCH_SHA256,
      targetRootSha256,
      targets: [{ descriptor }],
    };
    await store.activateTenantRestoreJournalControl({
      adapterProtocol: config.adapterProtocol,
      journalNamespaceSha256: config.journalNamespaceSha256,
      logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
      runtimeEpochSha256: config.runtimeEpochSha256,
      targets: [descriptor],
      observedHeads,
    });

    await expect(reconcileTenantRestoreJournalRuntimeForStartup({
      store,
      config,
      adapters: [adapter],
    })).resolves.toEqual({
      state: "ready",
      configured: true,
      targetCount: 1,
      observedRecordCount: 0,
      verifiedRecordCount: 0,
      runtimeControlGeneration: 1,
    });
    expect(validateStartup).toHaveBeenCalledOnce();
  });

  it("replays one exact entry safely after a concurrent commit loses its response", async () => {
    const state = await harness({
      recordCount: 1,
      responseLossAfterConcurrentAdvance: true,
    });
    await expect(reconcileTenantRestoreJournalRuntimeForStartup({
      store: state.store,
      config: state.config,
      adapters: [state.adapter],
    })).resolves.toMatchObject({
      state: "ready",
      observedRecordCount: 1,
      verifiedRecordCount: 1,
      runtimeControlGeneration: 2,
    });
    expect(state.assertKnown).toHaveBeenCalledTimes(2);
    expect(state.assertKnown.mock.calls[1]![0].remoteEntry)
      .toEqual(state.assertKnown.mock.calls[0]![0].remoteEntry);
    expect(state.assertKnown.mock.calls[1]![0]).toMatchObject({
      runtimeEpochSha256: state.assertKnown.mock.calls[0]![0].runtimeEpochSha256,
      controlEvidenceSha256: state.assertKnown.mock.calls[0]![0].controlEvidenceSha256,
      expectedControlGeneration: 2,
      targetOrdinal: 0,
    });
  });

  it("fails closed when rollback lost the exact local T1 admission and no restore fence exists", async () => {
    const state = await harness({ recordCount: 1, localKnownSequences: [] });
    let failure: unknown;
    try {
      await reconcileTenantRestoreJournalRuntimeForStartup({
        store: state.store,
        config: state.config,
        adapters: [state.adapter],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(expectCode("journal_entry_unknown"));
    expect(String(failure)).not.toContain("tenant-preflight-1");
    expect(String(failure)).not.toContain("physical locator");
    expect(state.assertReady).not.toHaveBeenCalled();
  });

  it("rejects a checkpoint that is not an ancestor of the immutable remote chain", async () => {
    const state = await harness({
      recordCount: 2,
      checkpointSequence: 1,
      checkpointRootOverride: "f".repeat(64),
    });
    await expect(reconcileTenantRestoreJournalRuntimeForStartup({
      store: state.store,
      config: state.config,
      adapters: [state.adapter],
    })).rejects.toEqual(expectCode("remote_chain_conflict"));
    expect(state.assertKnown).not.toHaveBeenCalled();
    expect(state.assertReady).not.toHaveBeenCalled();
  });

  it("rejects an external rollback below the durable checkpoint", async () => {
    const seeded = await harness({ recordCount: 1, checkpointSequence: 1 });
    const emptyHead: TenantRestoreJournalRemoteHead = {
      scope: "tenant-restore-journal-remote-head-v1",
      protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
      adapterProtocol: seeded.adapter.adapterProtocol,
      journalNamespaceSha256: seeded.adapter.journalNamespaceSha256,
      targetSha256: seeded.adapter.targetSha256,
      logicalDatabaseNamespaceSha256: seeded.adapter.logicalDatabaseNamespaceSha256,
      remoteSequence: 0,
      headRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
    };
    const state = await harness({
      recordCount: 1,
      checkpointSequence: 1,
      externalHeadOverride: emptyHead,
    });
    await expect(reconcileTenantRestoreJournalRuntimeForStartup({
      store: state.store,
      config: state.config,
      adapters: [state.adapter],
    })).rejects.toEqual(expectCode("remote_chain_conflict"));
  });

  it("fails closed for target catalog drift and for active control without configuration", async () => {
    const baseline = await harness();
    const driftedDescriptor = {
      ...baseline.descriptor,
      targetSha256: "f".repeat(64),
    };
    const drifted = await harness({ catalogOverride: [driftedDescriptor] });
    await expect(reconcileTenantRestoreJournalRuntimeForStartup({
      store: drifted.store,
      config: drifted.config,
      adapters: [drifted.adapter],
    })).rejects.toEqual(expectCode("control_mismatch"));

    await expect(reconcileTenantRestoreJournalRuntimeForStartup({
      store: baseline.store,
    })).rejects.toEqual(expectCode("missing_configuration"));
  });

  it("rejects inconsistent journal/runtime activation states", async () => {
    const inactiveJournal = await harness({ journalActive: false, runtimeActive: true });
    await expect(reconcileTenantRestoreJournalRuntimeForStartup({
      store: inactiveJournal.store,
      config: inactiveJournal.config,
      adapters: [inactiveJournal.adapter],
    })).rejects.toEqual(expectCode("runtime_not_ready"));

    const inactiveRuntime = await harness({ journalActive: true, runtimeActive: false });
    await expect(reconcileTenantRestoreJournalRuntimeForStartup({
      store: inactiveRuntime.store,
      config: inactiveRuntime.config,
      adapters: [inactiveRuntime.adapter],
    })).rejects.toEqual(expectCode("runtime_not_ready"));
  });

  it("sanitizes adapter startup failures and rejects unsafe bounds", async () => {
    const state = await harness({ startupError: true });
    let failure: unknown;
    try {
      await reconcileTenantRestoreJournalRuntimeForStartup({
        store: state.store,
        config: state.config,
        adapters: [state.adapter],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TenantRestoreJournalPreflightError);
    expect(failure).toEqual(expectCode("adapter_validation_failed"));
    expect(String(failure)).not.toContain("credential locator");
    expect(state.readHead).not.toHaveBeenCalled();

    const valid = await harness();
    await expect(reconcileTenantRestoreJournalRuntimeForStartup({
      store: valid.store,
      config: valid.config,
      adapters: [valid.adapter],
      scanPageSize: 0,
    })).rejects.toEqual(expectCode("invalid_configuration"));
  });
});
