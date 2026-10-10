import { describe, expect, it, vi } from "vitest";
import {
  MemorySessionStore,
  MemoryTenantRestoreJournalAdapter,
  TENANT_RESTORE_JOURNAL_PROTOCOL,
  TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
  tenantRestoreJournalOperationSha256,
  tenantRestoreJournalRecordSha256,
  tenantRestoreJournalTargetRootSha256,
  tenantRestoreLogicalDatabaseNamespaceSha256,
  tenantRestoreRuntimeControlEvidenceSha256,
  tenantRestoreRuntimeEpochSha256,
  type TenantRestoreJournalRecord,
  type TenantRestoreJournalTargetDescriptor,
} from "@agent-service/store";
import {
  formatRestoreLedgerReconcileCliError,
  runRestoreLedgerReconcileCli,
  type RestoreLedgerReconcileCliDependencies,
} from "../src/restore-ledger-reconcile-cli.js";
import type { TenantRestoreJournalRuntimeConfig } from
  "../src/tenant-restore-journal-config.js";

const MYSQL_URL = "mysql://fixture@127.0.0.1:3306/agent_service_test";
const RESTORE_RUN_ID = "restore_00000000-0000-4000-8000-000000000001";
const SOURCE_BACKUP_SHA256 = "a".repeat(64);
const LOGICAL_DATABASE_NAMESPACE_SHA256 = tenantRestoreLogicalDatabaseNamespaceSha256(
  "restore-cli-database-v1",
);

function record(index: number): TenantRestoreJournalRecord {
  const requestId = `erase_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const tenantId = `tenant-restore-cli-${index}`;
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

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { MYSQL_URL, ...extra };
}

function restoreEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return baseEnv({
    RESTORE_RUN_ID,
    RESTORE_FLEET_STOPPED_ACK: "1",
    SOURCE_BACKUP_SHA256,
    ...extra,
  });
}

function primaryActivationEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return baseEnv({
    RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK: "1",
    RESTORE_FLEET_STOPPED_ACK: "1",
    RESTORE_JOURNAL_S3_BUCKET: "restore-journal-fixture",
    BLOB_STORE: "filesystem",
    ...extra,
  });
}

function createHarness() {
  const store = new MemorySessionStore();
  const delegate = new MemoryTenantRestoreJournalAdapter({
    nonProductionFixture: true,
    namespaceId: "restore-cli-journal-v1",
    failureDomainId: "restore-cli-independent-fixture-v1",
    targetId: "restore-cli-target-v1",
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
  });
  const adapter = {
    adapterProtocol: delegate.adapterProtocol,
    journalNamespaceSha256: delegate.journalNamespaceSha256,
    targetSha256: delegate.targetSha256,
    failureDomainSha256: delegate.failureDomainSha256,
    logicalDatabaseNamespaceSha256: delegate.logicalDatabaseNamespaceSha256,
    validateStartup: vi.fn(async () => {}),
    publishRecord: (value: TenantRestoreJournalRecord) => delegate.publishRecord(value),
    inspectRecord: (value: TenantRestoreJournalRecord) => delegate.inspectRecord(value),
    readHead: () => delegate.readHead(),
    scanRecords: (options: Parameters<typeof delegate.scanRecords>[0]) => (
      delegate.scanRecords(options)
    ),
    // A CLI process would discard its client while the remote journal remains. Keep the in-memory
    // fake open so separate test invocations model that persistent external failure domain.
    close: vi.fn(async () => {}),
  };
  const descriptor: TenantRestoreJournalTargetDescriptor = {
    targetOrdinal: 0,
    targetSha256: adapter.targetSha256,
    failureDomainSha256: adapter.failureDomainSha256,
    adapterProtocol: adapter.adapterProtocol,
    journalNamespaceSha256: adapter.journalNamespaceSha256,
  };
  const runtimeConfig = (epochId: string): TenantRestoreJournalRuntimeConfig => ({
    adapterProtocol: adapter.adapterProtocol,
    journalNamespaceSha256: adapter.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    runtimeEpochSha256: tenantRestoreRuntimeEpochSha256(epochId),
    targetRootSha256: tenantRestoreJournalTargetRootSha256([descriptor]),
    targets: [{ descriptor, options: {} }],
  } as unknown as TenantRestoreJournalRuntimeConfig);
  let config = runtimeConfig("restore-cli-primary-epoch-v1");
  const output: string[] = [];
  const connectStore = vi.fn(async () => store);
  const createAdapters = vi.fn(() => [adapter]);
  const loadJournalConfig = vi.fn(() => config);
  const dependencies: RestoreLedgerReconcileCliDependencies = {
    connectStore: connectStore as RestoreLedgerReconcileCliDependencies["connectStore"],
    loadJournalConfig,
    createAdapters: createAdapters as RestoreLedgerReconcileCliDependencies["createAdapters"],
    writeLine: (line) => output.push(line),
  };
  return {
    store,
    delegate,
    adapter,
    descriptor,
    output,
    connectStore,
    createAdapters,
    loadJournalConfig,
    dependencies,
    useRestoreEpoch: () => { config = runtimeConfig("restore-cli-restored-epoch-v2"); },
    getConfig: () => config,
  };
}

async function activatePrimary(state: ReturnType<typeof createHarness>): Promise<void> {
  await runRestoreLedgerReconcileCli(
    ["activate-journal"],
    primaryActivationEnv(),
    state.dependencies,
  );
}

async function prepareSealedRestore(
  state: ReturnType<typeof createHarness>,
  recordIndex: number,
): Promise<void> {
  await activatePrimary(state);
  await state.delegate.publishRecord(record(recordIndex));
  state.useRestoreEpoch();
  await runRestoreLedgerReconcileCli(["run"], restoreEnv(), state.dependencies);
}

describe("restore-ledger-reconcile CLI", () => {
  it("activates an empty primary, replays a sealed rollback fence, and explicitly activates epoch N+1", async () => {
    const state = createHarness();
    await activatePrimary(state);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      status: "ok",
      command: "activate-journal",
      journalControlGeneration: 1,
      runtimeState: "active",
      runtimeControlGeneration: 1,
      runtimeUpdateKind: "primary_activation",
      targetCount: 1,
    });

    const remoteRecord = record(1);
    await state.delegate.publishRecord(remoteRecord);
    state.useRestoreEpoch();
    await runRestoreLedgerReconcileCli(["run"], restoreEnv({
      RESTORE_REPLAY_PAGE_SIZE: "1",
    }), state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "run",
      restorePhase: "replay_sealed",
      expectedEntryCount: 1,
      entryCount: 1,
      fenceCount: 1,
    });
    const fence = await state.store.getTenantRestoreFence(remoteRecord.tenantId);
    expect(fence).toMatchObject({
      requestId: remoteRecord.requestId,
      subjectGeneration: remoteRecord.subjectGeneration,
      recordSha256: remoteRecord.recordSha256,
    });
    const receipt = await state.store.getTenantRestoreReplayReceipt(RESTORE_RUN_ID);
    expect(receipt).toMatchObject({
      restoreFenceReplayComplete: true,
      physicalReplayComplete: false,
      allDomainsComplete: false,
      contentPurgeExecuted: false,
    });

    await runRestoreLedgerReconcileCli(
      ["activate-runtime"],
      restoreEnv(),
      state.dependencies,
    );
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "activate-runtime",
      restorePhase: "active",
      runtimeState: "active",
      runtimeUpdateKind: "restore_activation",
    });
    const runtime = await state.store.getTenantRestoreRuntimeControl();
    expect(runtime).toMatchObject({
      state: "active",
      lineageKind: "restore",
      restoreRunId: RESTORE_RUN_ID,
      runtimeEpochSha256: state.getConfig().runtimeEpochSha256,
    });

    await runRestoreLedgerReconcileCli(
      ["status"],
      baseEnv({ RESTORE_RUN_ID }),
      state.dependencies,
    );
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "status",
      restorePhase: "active",
      entryCount: 1,
      fenceCount: 1,
    });
    expect(state.createAdapters).toHaveBeenCalledTimes(3);
  });

  it("refuses primary activation when an external target is not exactly empty", async () => {
    const state = createHarness();
    await state.delegate.publishRecord(record(2));
    await expect(runRestoreLedgerReconcileCli(
      ["activate-journal"],
      primaryActivationEnv(),
      state.dependencies,
    )).rejects.toMatchObject({ code: "journal_not_empty" });
    expect(await state.store.getTenantRestoreJournalControl()).toEqual({
      singletonId: 1,
      controlGeneration: 0,
    });
  });

  it("keeps status and abort available without constructing an object-store adapter", async () => {
    const state = createHarness();
    await runRestoreLedgerReconcileCli(["status"], baseEnv(), state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "status",
      journalControlGeneration: 0,
      runtimeState: "inactive",
    });
    expect(state.createAdapters).not.toHaveBeenCalled();
    expect(state.adapter.validateStartup).not.toHaveBeenCalled();
    expect(state.connectStore).toHaveBeenCalledWith({
      url: MYSQL_URL,
      connectionLimit: 1,
      migrationMode: "verify",
    });
  });

  it("validates all primary authority before loading config, constructing adapters, or connecting", async () => {
    const state = createHarness();
    const unsafe = "do-not-echo-this-value";
    let failure: unknown;
    try {
      await runRestoreLedgerReconcileCli(["activate-journal"], primaryActivationEnv({
        RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK: unsafe,
      }), state.dependencies);
    } catch (error) {
      failure = error;
    }
    expect(state.connectStore).not.toHaveBeenCalled();
    expect(state.loadJournalConfig).not.toHaveBeenCalled();
    expect(state.createAdapters).not.toHaveBeenCalled();
    const formatted = formatRestoreLedgerReconcileCliError(failure);
    expect(formatted).toBe('{"status":"error","code":"invalid_configuration"}');
    expect(formatted).not.toContain(unsafe);
  });

  it("requires stopped-fleet authority and an explicit isolated Blob backend before activation", async () => {
    const invalidEnvironments = [
      primaryActivationEnv({ RESTORE_FLEET_STOPPED_ACK: undefined }),
      primaryActivationEnv({ RESTORE_FLEET_STOPPED_ACK: "0" }),
      primaryActivationEnv({ BLOB_STORE: undefined }),
      primaryActivationEnv({ BLOB_STORE: "unknown" }),
      primaryActivationEnv({ BLOB_STORE: "s3", BLOB_S3_BUCKET: undefined }),
      primaryActivationEnv({ BLOB_STORE: "s3", BLOB_S3_BUCKET: "INVALID_BUCKET" }),
      primaryActivationEnv({
        BLOB_STORE: "s3",
        BLOB_S3_BUCKET: "restore-journal-fixture",
      }),
    ];
    for (const env of invalidEnvironments) {
      const state = createHarness();
      let failure: unknown;
      try {
        await runRestoreLedgerReconcileCli(
          ["activate-journal"],
          env,
          state.dependencies,
        );
      } catch (error) {
        failure = error;
      }
      expect(formatRestoreLedgerReconcileCliError(failure))
        .toBe('{"status":"error","code":"invalid_configuration"}');
      expect(state.loadJournalConfig).not.toHaveBeenCalled();
      expect(state.createAdapters).not.toHaveBeenCalled();
      expect(state.connectStore).not.toHaveBeenCalled();
    }
  });

  it("passes a validated distinct Blob S3 bucket into primary journal configuration", async () => {
    const state = createHarness();
    const env = primaryActivationEnv({
      BLOB_STORE: "s3",
      BLOB_S3_BUCKET: "blob-fixture-bucket",
    });
    await expect(runRestoreLedgerReconcileCli(
      ["activate-journal"],
      env,
      state.dependencies,
    )).resolves.toBe(0);
    expect(state.loadJournalConfig).toHaveBeenCalledWith(env, {
      production: false,
      store: "mysql",
      blobS3Bucket: "blob-fixture-bucket",
    });
  });

  it("validates restore command settings before loading config or constructing adapters", async () => {
    const invalidInvocations: Array<{
      command: "prepare" | "replay-fences" | "activate-runtime" | "run";
      env: NodeJS.ProcessEnv;
    }> = [
      { command: "prepare", env: restoreEnv({ SOURCE_BACKUP_SHA256: "invalid" }) },
      { command: "replay-fences", env: restoreEnv({ RESTORE_REPLAY_PAGE_SIZE: "0" }) },
      { command: "activate-runtime", env: restoreEnv({ RESTORE_FLEET_STOPPED_ACK: "0" }) },
      { command: "run", env: restoreEnv({ RESTORE_REPLAY_PAGE_SIZE: "1001" }) },
    ];
    for (const invocation of invalidInvocations) {
      const state = createHarness();
      let failure: unknown;
      try {
        await runRestoreLedgerReconcileCli(
          [invocation.command],
          invocation.env,
          state.dependencies,
        );
      } catch (error) {
        failure = error;
      }
      expect(formatRestoreLedgerReconcileCliError(failure))
        .toBe('{"status":"error","code":"invalid_configuration"}');
      expect(state.loadJournalConfig).not.toHaveBeenCalled();
      expect(state.createAdapters).not.toHaveBeenCalled();
      expect(state.connectStore).not.toHaveBeenCalled();
    }
  });

  it("blocks activation when the external head advanced after the replay was sealed", async () => {
    const state = createHarness();
    await activatePrimary(state);
    await state.delegate.publishRecord(record(3));
    state.useRestoreEpoch();
    await runRestoreLedgerReconcileCli(["run"], restoreEnv(), state.dependencies);
    await state.delegate.publishRecord(record(4));
    await expect(runRestoreLedgerReconcileCli(
      ["activate-runtime"],
      restoreEnv(),
      state.dependencies,
    )).rejects.toMatchObject({ code: "runtime_head_changed" });
    expect((await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))?.phase)
      .toBe("replay_sealed");
  });

  it("replays the combined run command exactly after its final response is lost", async () => {
    const state = createHarness();
    await activatePrimary(state);
    await state.delegate.publishRecord(record(14));
    state.useRestoreEpoch();
    await expect(runRestoreLedgerReconcileCli(
      ["run"],
      restoreEnv(),
      state.dependencies,
    )).resolves.toBe(0);
    const before = await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID);
    const receipt = await state.store.getTenantRestoreReplayReceipt(RESTORE_RUN_ID);

    await expect(runRestoreLedgerReconcileCli(
      ["run"],
      restoreEnv(),
      state.dependencies,
    )).resolves.toBe(0);
    expect(await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID)).toEqual(before);
    expect(await state.store.getTenantRestoreReplayReceipt(RESTORE_RUN_ID)).toEqual(receipt);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "run",
      restorePhase: "replay_sealed",
      entryCount: 1,
      fenceCount: 1,
    });
  });

  it("recovers exact prepare, replay, verify and runtime-activation response loss", async () => {
    const state = createHarness();
    await activatePrimary(state);
    await state.delegate.publishRecord(record(5));
    state.useRestoreEpoch();

    const originalPrepare = state.store.prepareTenantRestoreReplay.bind(state.store);
    let losePrepareResponse = true;
    state.store.prepareTenantRestoreReplay = async (input) => {
      const result = await originalPrepare(input);
      if (losePrepareResponse) {
        losePrepareResponse = false;
        throw new Error("unsafe prepare response");
      }
      return result;
    };
    await expect(runRestoreLedgerReconcileCli(
      ["prepare"],
      restoreEnv(),
      state.dependencies,
    )).resolves.toBe(0);
    expect((await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))?.phase).toBe("prepared");

    const originalRecord = state.store.recordTenantRestoreReplayFence.bind(state.store);
    let loseRecordResponse = true;
    state.store.recordTenantRestoreReplayFence = async (input) => {
      const result = await originalRecord(input);
      if (loseRecordResponse) {
        loseRecordResponse = false;
        throw new Error("unsafe replay response");
      }
      return result;
    };
    await expect(runRestoreLedgerReconcileCli(
      ["replay-fences"],
      restoreEnv(),
      state.dependencies,
    )).resolves.toBe(0);

    const originalSeal = state.store.sealTenantRestoreReplay.bind(state.store);
    let loseSealResponse = true;
    state.store.sealTenantRestoreReplay = async (restoreRunId) => {
      const result = await originalSeal(restoreRunId);
      if (loseSealResponse) {
        loseSealResponse = false;
        throw new Error("unsafe verify response");
      }
      return result;
    };
    await expect(runRestoreLedgerReconcileCli(
      ["verify"],
      restoreEnv(),
      state.dependencies,
    )).resolves.toBe(0);
    expect((await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))?.phase)
      .toBe("replay_sealed");

    const originalActivate = state.store.activateTenantRestoreRuntime.bind(state.store);
    let loseActivationResponse = true;
    state.store.activateTenantRestoreRuntime = async (input) => {
      const result = await originalActivate(input);
      if (loseActivationResponse) {
        loseActivationResponse = false;
        throw new Error("unsafe activation response");
      }
      return result;
    };
    await expect(runRestoreLedgerReconcileCli(
      ["activate-runtime"],
      restoreEnv(),
      state.dependencies,
    )).resolves.toBe(0);
    expect(await state.store.getTenantRestoreRuntimeControl()).toMatchObject({
      state: "active",
      updateKind: "restore_activation",
      restoreRunId: RESTORE_RUN_ID,
    });
  });

  it("rejects a validator-valid but non-exact prepare response-loss projection", async () => {
    const state = createHarness();
    await activatePrimary(state);
    await state.delegate.publishRecord(record(11));
    state.useRestoreEpoch();
    const originalPrepare = state.store.prepareTenantRestoreReplay.bind(state.store);
    const originalGetRun = state.store.getTenantRestoreReplayRun.bind(state.store);
    state.store.prepareTenantRestoreReplay = async (input) => {
      await originalPrepare(input);
      state.store.getTenantRestoreReplayRun = async (restoreRunId) => {
        const run = await originalGetRun(restoreRunId);
        return run ? { ...run, adapterProtocol: "forged-adapter-v1" } : null;
      };
      throw new Error("unsafe prepare response");
    };

    await expect(runRestoreLedgerReconcileCli(
      ["prepare"],
      restoreEnv(),
      state.dependencies,
    )).rejects.toThrow("unsafe prepare response");
  });

  it("recovers only an exact aborted run after abort response loss", async () => {
    const state = createHarness();
    await activatePrimary(state);
    await state.delegate.publishRecord(record(6));
    state.useRestoreEpoch();
    await runRestoreLedgerReconcileCli(["prepare"], restoreEnv(), state.dependencies);
    const originalAbort = state.store.abortTenantRestoreReplay.bind(state.store);
    let loseAbortResponse = true;
    state.store.abortTenantRestoreReplay = async (restoreRunId) => {
      const result = await originalAbort(restoreRunId);
      if (loseAbortResponse) {
        loseAbortResponse = false;
        throw new Error("unsafe abort response");
      }
      return result;
    };
    await expect(runRestoreLedgerReconcileCli(
      ["abort"],
      restoreEnv(),
      state.dependencies,
    )).resolves.toBe(0);
    expect((await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))?.phase).toBe("aborted");
    expect(state.createAdapters).toHaveBeenCalledTimes(2);
  });

  it("rejects a validator-valid but non-exact runtime response-loss projection", async () => {
    const state = createHarness();
    await prepareSealedRestore(state, 7);
    const originalActivate = state.store.activateTenantRestoreRuntime.bind(state.store);
    state.store.activateTenantRestoreRuntime = async (input) => {
      const result = await originalActivate(input);
      if (result.state !== "active" || result.lineageKind !== "restore") {
        throw new Error("unexpected runtime state");
      }
      const { evidenceSha256: _evidenceSha256, ...body } = result;
      const forgedBody = {
        ...body,
        replayReceiptSha256: "f".repeat(64),
      };
      const forged = {
        ...forgedBody,
        evidenceSha256: tenantRestoreRuntimeControlEvidenceSha256(forgedBody),
      };
      state.store.getTenantRestoreRuntimeControl = async () => structuredClone(forged);
      throw new Error("unsafe activation response");
    };
    await expect(runRestoreLedgerReconcileCli(
      ["activate-runtime"],
      restoreEnv(),
      state.dependencies,
    )).rejects.toMatchObject({ code: "invalid_durable_state" });
  });

  it("reports primary post-commit head drift as forward-fix required", async () => {
    const state = createHarness();
    const original = state.store.activateTenantRestoreJournalControl.bind(state.store);
    state.store.activateTenantRestoreJournalControl = async (input) => {
      const result = await original(input);
      await state.delegate.publishRecord(record(8));
      return result;
    };
    await expect(activatePrimary(state)).rejects.toMatchObject({
      code: "runtime_head_changed_forward_fix_required",
    });
    expect((await state.store.getTenantRestoreJournalControl()).controlGeneration).toBe(1);
  });

  it("reports restored-runtime post-commit head drift as forward-fix required", async () => {
    const state = createHarness();
    await prepareSealedRestore(state, 9);
    const original = state.store.activateTenantRestoreRuntime.bind(state.store);
    state.store.activateTenantRestoreRuntime = async (input) => {
      const result = await original(input);
      await state.delegate.publishRecord(record(10));
      return result;
    };
    await expect(runRestoreLedgerReconcileCli(
      ["activate-runtime"],
      restoreEnv(),
      state.dependencies,
    )).rejects.toMatchObject({
      code: "runtime_head_changed_forward_fix_required",
    });
    expect((await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))?.phase).toBe("active");
  });

  it("recovers only an exact primary-activation response loss and sanitizes unknown errors", async () => {
    const state = createHarness();
    const original = state.store.activateTenantRestoreJournalControl.bind(state.store);
    let loseResponse = true;
    state.store.activateTenantRestoreJournalControl = async (input) => {
      const result = await original(input);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("unsafe backend response with tenant and credential locator");
      }
      return result;
    };
    await expect(activatePrimary(state)).resolves.toBeUndefined();
    expect((await state.store.getTenantRestoreRuntimeControl())).toMatchObject({
      state: "active",
      updateKind: "primary_activation",
      lineageKind: "primary",
    });
    const formatted = formatRestoreLedgerReconcileCliError(
      new Error("secret backend locator and tenant id"),
    );
    expect(formatted).toBe('{"status":"error","code":"operation_failed"}');
    expect(formatted).not.toContain("locator");
    expect(formatted).not.toContain("tenant");
  });
});
