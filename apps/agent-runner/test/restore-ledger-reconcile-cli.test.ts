import { describe, expect, it, vi } from "vitest";
import {
  MemorySessionStore,
  MemoryTenantRestoreJournalAdapter,
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  prepareSessionAuthorityBindingCommand, captureSessionAuthorityBindingCommand,
  prepareSessionAuthorityActivationRequest, captureSessionAuthorityActivationRequest,
  type SessionAuthorityBindingOperatorContext, type SessionAuthorityBindingSource,
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
import { assertSessionAuthorityActivationRequest } from "../../../packages/store/src/mysql/session-authority-binding.js";
import type { SessionAuthorityNextEpoch } from "../../../packages/store/src/mysql/session-authority-binding-types.js";
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

// Explicit orchestration inputs only. No metadata/grants/native identity is synthesized as proof.
const SCHEMA_METADATA = Object.freeze({ metadataSchema: "restore_cli_metadata",
  trustedDefiner: Object.freeze({ user: "restore_cli_metadata_definer", host: "localhost" }) });
const RUNTIME_PROFILE = Object.freeze({ kind: "runtime-maintenance" as const, schemaMetadata: SCHEMA_METADATA });
type AuthorityKind = "primary_activation" | "restore_activation";
type ReconcilePort = Awaited<ReturnType<RestoreLedgerReconcileCliDependencies["connectStore"]>>;
function authorityEnvironment(kind: AuthorityKind): NodeJS.ProcessEnv {
  return { AUTHORITY_MYSQL_URL: MYSQL_URL,
    AUTHORITY_COMMAND_FILE: kind === "primary_activation" ? "/private/restore-cli-primary-authority.json" : "/private/restore-cli-runtime-authority.json",
    AUTHORITY_FLEET_STOPPED_ACK: "all-application-writers-stopped-v1",
    AUTHORITY_EXCLUSIVE_CHANGE_ACK: "exclusive-authority-permissions-window-v1",
    AUTHORITY_METADATA_SCHEMA: SCHEMA_METADATA.metadataSchema,
    AUTHORITY_METADATA_DEFINER_USER: SCHEMA_METADATA.trustedDefiner.user,
    AUTHORITY_METADATA_DEFINER_HOST: SCHEMA_METADATA.trustedDefiner.host };
}

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
  return { MYSQL_URL, MYSQL_SCHEMA_METADATA_SCHEMA: SCHEMA_METADATA.metadataSchema,
    MYSQL_SCHEMA_METADATA_DEFINER_USER: SCHEMA_METADATA.trustedDefiner.user,
    MYSQL_SCHEMA_METADATA_DEFINER_HOST: SCHEMA_METADATA.trustedDefiner.host, ...extra };
}

function restoreEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return baseEnv({
    RESTORE_RUN_ID,
    RESTORE_FLEET_STOPPED_ACK: "1",
    SOURCE_BACKUP_SHA256,
    ...extra,
  });
}

function runtimeActivationEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return restoreEnv({ ...authorityEnvironment("restore_activation"), ...extra });
}

function primaryActivationEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return baseEnv({
    ...authorityEnvironment("primary_activation"),
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
  const contexts = new Map<AuthorityKind, SessionAuthorityBindingOperatorContext>();
  const observedRequests = new Map<AuthorityKind, string>();
  let currentLoadSignal: AbortSignal | undefined;
  let currentAdapterSignal: AbortSignal | undefined;
  let currentProfile: Parameters<RestoreLedgerReconcileCliDependencies["connectStore"]>[0]["maintenance"] | undefined;
  const nativeAdmission = vi.fn(async () => { throw new Error("synthetic_fixture_has_no_native_admission"); });
  const loadAuthorityContext: NonNullable<RestoreLedgerReconcileCliDependencies["loadAuthorityContext"]> = vi.fn(async (
    configuration: Parameters<NonNullable<RestoreLedgerReconcileCliDependencies["loadAuthorityContext"]>>[0],
    signal: Parameters<NonNullable<RestoreLedgerReconcileCliDependencies["loadAuthorityContext"]>>[1],
  ) => {
    expect(configuration.url).toBe(MYSQL_URL); expect(configuration.schemaMetadata).toEqual(SCHEMA_METADATA);
    expect(configuration.timeoutMs).toBe(120_000); expect(signal).toBeInstanceOf(AbortSignal); expect(signal!.aborted).toBe(false);
    currentLoadSignal = signal;
    const kind: AuthorityKind = configuration.commandFile === "/private/restore-cli-primary-authority.json" ? "primary_activation"
      : configuration.commandFile === "/private/restore-cli-runtime-authority.json" ? "restore_activation" : (() => { throw Error("synthetic_fixed_file_missing"); })();
    const retained = contexts.get(kind); if (retained) return retained;
    const oldRuntime = await store.getTenantRestoreRuntimeControl();
    let source: SessionAuthorityBindingSource;
    let input: Parameters<typeof store.activateTenantRestoreJournalControl>[0] | Parameters<typeof store.activateTenantRestoreRuntime>[0];
    let sealedReceipt: string | null = null;
    if (kind === "primary_activation") {
      if (oldRuntime.state !== "inactive" || oldRuntime.controlGeneration !== 0) throw Error("synthetic_initial_source_missing");
      source = { kind: "inactive", runtimeControlGeneration: 0, runtimeControlEvidenceSha256: null,
        runtimeEpochSha256: null, restoreRunId: null, replayReceiptSha256: null };
      const targets = config.targets.map(target => target.descriptor);
      // This is a preselected empty-head intent, not an external read that hides journal_not_empty.
      input = { adapterProtocol: config.adapterProtocol, journalNamespaceSha256: config.journalNamespaceSha256,
        logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256, runtimeEpochSha256: config.runtimeEpochSha256, targets,
        observedHeads: targets.map(target => ({ ...target, logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
          sealedRemoteSequence: 0, sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256 })) };
    } else {
      if (oldRuntime.state !== "active") throw Error("synthetic_old_epoch_missing");
      const events = [...store.tenantRestoreRuntimeControlEvents.values()].filter(event => event.runtimeEpochSha256 === oldRuntime.runtimeEpochSha256
        && (event.updateKind === "primary_activation" || event.updateKind === "restore_activation"));
      if (events.length !== 1) throw Error("synthetic_immutable_source_missing");
      const event = events[0]!;
      if (event.updateKind === "primary_activation") {
        if (Object.hasOwn(event, "restoreRunId") || Object.hasOwn(event, "replayReceiptSha256")) throw Error("synthetic_primary_source_invalid");
        source = { kind: "primary_activation", runtimeControlGeneration: event.controlGeneration,
          runtimeControlEvidenceSha256: event.evidenceSha256, runtimeEpochSha256: event.runtimeEpochSha256,
          restoreRunId: null, replayReceiptSha256: null };
      } else {
        if (event.updateKind !== "restore_activation" || typeof event.restoreRunId !== "string" || typeof event.replayReceiptSha256 !== "string")
          throw Error("synthetic_restore_source_invalid");
        source = { kind: "restore_activation", runtimeControlGeneration: event.controlGeneration,
          runtimeControlEvidenceSha256: event.evidenceSha256, runtimeEpochSha256: event.runtimeEpochSha256,
          restoreRunId: event.restoreRunId, replayReceiptSha256: event.replayReceiptSha256 };
      }
      const run = await store.getTenantRestoreReplayRun(RESTORE_RUN_ID);
      if (!run || run.phase !== "replay_sealed" || run.terminalReceiptSha256 === null) throw Error("synthetic_sealed_source_missing");
      sealedReceipt = run.terminalReceiptSha256;
      input = { restoreRunId: RESTORE_RUN_ID, expectedControlGeneration: oldRuntime.controlGeneration };
    }
    const request = captureSessionAuthorityActivationRequest(prepareSessionAuthorityActivationRequest(kind, input));
    const predecessor = kind === "restore_activation" ? contexts.get("primary_activation") : undefined;
    if (kind === "restore_activation" && !predecessor) throw Error("synthetic_predecessor_command_missing");
    let nextEpoch: SessionAuthorityNextEpoch;
    if (kind === "primary_activation") nextEpoch = { kind, runtimeEpochSha256: config.runtimeEpochSha256, restoreRunId: null,
      activationRequestSha256: request.activationRequestSha256, sealedReplayReceiptSha256: null };
    else {
      if (sealedReceipt === null) throw Error("synthetic_sealed_receipt_missing");
      nextEpoch = { kind, runtimeEpochSha256: config.runtimeEpochSha256, restoreRunId: RESTORE_RUN_ID,
        activationRequestSha256: request.activationRequestSha256, sealedReplayReceiptSha256: sealedReceipt };
    }
    const command = prepareSessionAuthorityBindingCommand({
      bindingId: kind === "primary_activation" ? "11111111-1111-4111-8111-111111111111" : "55555555-5555-4555-8555-555555555555",
      activationId: kind === "primary_activation" ? "22222222-2222-4222-8222-222222222222" : "66666666-6666-4666-8666-666666666666",
      expectedBindingId: predecessor ? captureSessionAuthorityBindingCommand(predecessor.command).bindingId : "44444444-4444-4444-8444-444444444444",
      expectedSequence: kind === "primary_activation" ? 1 : 2,
      serverUuid: "33333333-3333-4333-8333-333333333333", applicationDatabase: "agent_service_test",
      newAccounts: [{ user: kind === "primary_activation" ? "restore_cli_runtime_primary" : "restore_cli_runtime_next", host: "localhost" }],
      oldAccountNames: kind === "primary_activation" ? ["restore_cli_runtime_before"] : ["restore_cli_runtime_before", "restore_cli_runtime_primary"],
      activationEvidenceSha256: "a".repeat(64), expectedSource: source, nextEpoch,
    });
    const fixed = Object.freeze({ command, schemaMetadata: SCHEMA_METADATA, assertNativeAdmission: nativeAdmission });
    contexts.set(kind, fixed); return fixed;
  });
  function recordRequest(kind: AuthorityKind, input: unknown): void {
    const fixed = contexts.get(kind);
    if (!fixed || currentProfile?.kind !== "operator-maintenance" || currentProfile.binding !== fixed) throw Error("synthetic_operator_profile_missing");
    const request = prepareSessionAuthorityActivationRequest(kind, input);
    assertSessionAuthorityActivationRequest(fixed, request);
    observedRequests.set(kind, captureSessionAuthorityActivationRequest(request).activationRequestSha256);
  }
  const originalPrimary = store.activateTenantRestoreJournalControl.bind(store);
  store.activateTenantRestoreJournalControl = async input => { recordRequest("primary_activation", input); return originalPrimary(input); };
  const originalRestore = store.activateTenantRestoreRuntime.bind(store);
  store.activateTenantRestoreRuntime = async input => { recordRequest("restore_activation", input); return originalRestore(input); };
  const confirmBinding = vi.fn(async () => {
    if (currentProfile?.kind !== "operator-maintenance") throw Error("synthetic_operator_profile_missing");
    const fixed = captureSessionAuthorityBindingCommand(currentProfile.binding.command), next = fixed.nextEpoch;
    const actual = await store.getTenantRestoreRuntimeControl();
    if (!next || observedRequests.get(next.kind) !== next.activationRequestSha256 || actual.state !== "active"
      || actual.updateKind !== next.kind || actual.runtimeEpochSha256 !== next.runtimeEpochSha256) throw Error("synthetic_authority_confirmation_unknown");
    if (next.kind === "restore_activation") {
      const run = await store.getTenantRestoreReplayRun(RESTORE_RUN_ID);
      if (run?.phase !== "active" || run.restoreRunId !== next.restoreRunId || run.terminalReceiptSha256 !== next.sealedReplayReceiptSha256
        || actual.restoreRunId !== next.restoreRunId || actual.replayReceiptSha256 !== next.sealedReplayReceiptSha256) throw Error("synthetic_authority_confirmation_unknown");
    }
    expect(nativeAdmission).not.toHaveBeenCalled(); // No fake successful native admission/MySQL binding.
  });
  const connectionClose = vi.fn(async () => {});
  const connectStore = vi.fn(async (options: Parameters<RestoreLedgerReconcileCliDependencies["connectStore"]>[0]): Promise<ReconcilePort> => {
    expect(options.url).toBe(MYSQL_URL); expect(options.migrationMode).toBe("verify");
    if (options.maintenance.kind === "operator-maintenance") {
      expect(options.operationAbortSignal).toBeInstanceOf(AbortSignal); expect(options.operationAbortSignal!.aborted).toBe(false);
      expect(options.operationAbortSignal).toBe(currentLoadSignal);
      expect(options.operationAbortSignal).toBe(currentAdapterSignal);
      expect([...contexts.values()]).toContain(options.maintenance.binding);
      expect(options.maintenance.binding.schemaMetadata).toEqual(SCHEMA_METADATA);
    } else { expect(options.maintenance).toEqual(RUNTIME_PROFILE);
      expect(options.operationAbortSignal).toBeInstanceOf(AbortSignal); expect(options.operationAbortSignal!.aborted).toBe(false); }
    currentProfile = options.maintenance;
    // Each invocation represents a new synthetic client. Closing it preserves the backing
    // Memory database for exact cold/retry orchestration, just like the fake journal above.
    let closed = false;
    return new Proxy(Object.create(null) as ReconcilePort, { get(_view, key) {
      if (key === "close") return async () => { if (!closed) { closed = true; await connectionClose(); } };
      if (key === "confirmSessionAuthorityBinding") return () => {
        if (closed) throw Error("synthetic_client_closed"); return confirmBinding();
      };
      const value = Reflect.get(store, key, store);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (closed) throw Error("synthetic_client_closed");
        const method = Reflect.get(store, key, store); if (typeof method !== "function") throw Error("synthetic_method_missing");
        return Reflect.apply(method, store, args);
      };
    } });
  });
  const createAdapters = vi.fn((_config: TenantRestoreJournalRuntimeConfig, operation?: { operationAbortSignal?: AbortSignal }) => {
    expect(operation?.operationAbortSignal).toBeInstanceOf(AbortSignal);
    expect(operation!.operationAbortSignal!.aborted).toBe(false); currentAdapterSignal = operation!.operationAbortSignal;
    return [adapter];
  });
  const loadJournalConfig = vi.fn(() => config);
  const dependencies: RestoreLedgerReconcileCliDependencies = {
    connectStore: connectStore as RestoreLedgerReconcileCliDependencies["connectStore"],
    loadJournalConfig, loadAuthorityContext,
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
    dependencies, contexts, loadAuthorityContext, confirmBinding, nativeAdmission, connectionClose,
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
  it("passes protected raw bytes into verify-only status and preserves an independent store-owned copy", async () => {
    const state = createHarness();
    const key = Buffer.alloc(32, 0x43);
    let ownedCopy: Buffer | undefined;
    state.dependencies.readRefKey = async () => key;
    state.connectStore.mockImplementation(async (input) => {
      expect(input.migrationMode).toBe("verify");
      expect(input.tenantTelemetryRefKey instanceof Uint8Array).toBe(true);
      expect(input.tenantTelemetryRefKey!.length).toBe(32);
      expect(input.tenantTelemetryRefKey!.every((byte) => byte === 0x43), "exact protected key required").toBe(true);
      ownedCopy = Buffer.from(input.tenantTelemetryRefKey!);
      return state.store;
    });
    await runRestoreLedgerReconcileCli(["status"], baseEnv({ TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/ref-key" }), state.dependencies);
    expect(key.every((byte) => byte === 0), "operator buffer must be zeroed").toBe(true);
    expect(ownedCopy!.every((byte) => byte === 0x43), "store copy must remain valid until store closure").toBe(true);
    ownedCopy!.fill(0);
    expect(state.createAdapters).not.toHaveBeenCalled();
    expect(state.output.join("\n")).not.toContain("ref-key");
  });

  it.each([{ TENANT_TELEMETRY_REF_KEY: "" }, { TENANT_TELEMETRY_REF_KEY: "private-key" },
    { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "" }, { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "relative" }])(
    "rejects ambient application key and invalid operator key input before connection %#", async (extra) => {
      const state = createHarness();
      const failure = await runRestoreLedgerReconcileCli(["status"], baseEnv(extra), state.dependencies).catch((error: unknown) => error);
      expect(formatRestoreLedgerReconcileCliError(failure)).toBe('{"status":"error","code":"invalid_configuration"}');
      expect(state.connectStore).not.toHaveBeenCalled();
      expect(state.createAdapters).not.toHaveBeenCalled();
    });

  it("zeros its key and preserves fail-closed startup without leaking audit diagnostics", async () => {
    const state = createHarness();
    const key = Buffer.alloc(32, 0x47);
    state.dependencies.readRefKey = async () => key;
    state.connectStore.mockImplementation(async () => { throw new Error("private-DB-key-audit-details"); });
    const failure = await runRestoreLedgerReconcileCli(["status"], baseEnv({ TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/ref-key" }), state.dependencies)
      .catch((error: unknown) => error);
    expect(formatRestoreLedgerReconcileCliError(failure)).toBe('{"status":"error","code":"operation_failed"}');
    expect(key.every((byte) => byte === 0), "startup rejection must zero key").toBe(true);
    expect(state.output).toEqual([]);
  });

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
      runtimeActivationEnv(),
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
      maintenance: RUNTIME_PROFILE,
      operationAbortSignal: expect.any(AbortSignal),
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
      { command: "activate-runtime", env: runtimeActivationEnv({ RESTORE_FLEET_STOPPED_ACK: "0" }) },
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
      runtimeActivationEnv(),
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
      runtimeActivationEnv(),
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
      runtimeActivationEnv(),
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
      runtimeActivationEnv(),
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


// These extra orchestration checks intentionally do not claim native MySQL binding proof.
describe("restore fixed-authority orchestration (synthetic ports)", () => {
  it("retains the exact captured primary command across an already-active replay without refreshing its source", async () => {
    const state = createHarness();
    await activatePrimary(state);
    const fixed = state.contexts.get("primary_activation")!;
    const before = await state.store.getTenantRestoreRuntimeControl();
    const events = structuredClone(state.store.tenantRestoreRuntimeControlEvents);
    await activatePrimary(state);
    expect(state.contexts.get("primary_activation")).toBe(fixed);
    expect(captureSessionAuthorityBindingCommand(fixed.command).expectedSource.kind).toBe("inactive");
    expect(await state.store.getTenantRestoreRuntimeControl()).toEqual(before);
    expect(state.store.tenantRestoreRuntimeControlEvents).toEqual(events);
    expect(state.loadAuthorityContext).toHaveBeenCalledTimes(2);
    expect(state.confirmBinding).toHaveBeenCalledTimes(2);
    expect(state.nativeAdmission).not.toHaveBeenCalled();
    expect(state.connectionClose).toHaveBeenCalledTimes(2);
  });

  it("refuses an ok summary after a synthetic binding confirmation failure and retries only that same command", async () => {
    const state = createHarness(), failure = Error("synthetic confirmation remains unknown");
    state.confirmBinding.mockRejectedValueOnce(failure);
    await expect(activatePrimary(state)).rejects.toBe(failure);
    expect(state.output).toEqual([]);
    const fixed = state.contexts.get("primary_activation")!;
    const actual = await state.store.getTenantRestoreRuntimeControl();
    expect(actual).toMatchObject({ state: "active", updateKind: "primary_activation" });
    await activatePrimary(state);
    expect(state.contexts.get("primary_activation")).toBe(fixed);
    expect(await state.store.getTenantRestoreRuntimeControl()).toEqual(actual);
    expect(state.confirmBinding).toHaveBeenCalledTimes(2);
    expect(state.nativeAdmission).not.toHaveBeenCalled();
    expect(state.connectionClose).toHaveBeenCalledTimes(2);
    expect(JSON.parse(state.output[0]!)).toMatchObject({ status: "ok", command: "activate-journal" });
  });
});


// Synthetic CLI orchestration only: this eight-method Memory port proves neither
// native grants/identity nor a physical restored target or stopped-fleet admission.
type StoppedReplayPort = Awaited<ReturnType<NonNullable<RestoreLedgerReconcileCliDependencies["connectStoppedReplayMaintenance"]>>>;
function stoppedReplayEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { MYSQL_URL, RESTORE_LEDGER_REPLAY_STOPPED_LOCAL_ACK: "1", RESTORE_FLEET_STOPPED_ACK: "1", ...extra };
}
function createStoppedReplayHarness() {
  const state = createHarness(), stoppedClose = vi.fn(async () => {});
  const port: StoppedReplayPort = Object.freeze({
    getTenantRestoreJournalControl: state.store.getTenantRestoreJournalControl.bind(state.store),
    getTenantRestoreRuntimeControl: state.store.getTenantRestoreRuntimeControl.bind(state.store),
    getTenantRestoreReplayRun: state.store.getTenantRestoreReplayRun.bind(state.store),
    getTenantRestoreReplaySealedTargets: state.store.getTenantRestoreReplaySealedTargets.bind(state.store),
    recordTenantRestoreReplayFence: state.store.recordTenantRestoreReplayFence.bind(state.store),
    sealTenantRestoreReplay: state.store.sealTenantRestoreReplay.bind(state.store),
    getTenantRestoreReplayReceipt: state.store.getTenantRestoreReplayReceipt.bind(state.store),
    close: () => stoppedClose(),
  });
  const connectStopped = vi.fn(async (
    options: Parameters<NonNullable<RestoreLedgerReconcileCliDependencies["connectStoppedReplayMaintenance"]>>[0],
    profile: Parameters<NonNullable<RestoreLedgerReconcileCliDependencies["connectStoppedReplayMaintenance"]>>[1],
  ): Promise<StoppedReplayPort> => {
    expect(options.url).toBe(MYSQL_URL); expect(options.operationAbortSignal).toBeInstanceOf(AbortSignal);
    expect(options.operationAbortSignal!.aborted).toBe(false);
    expect(Object.keys(options).sort()).toEqual(["url", "connectionLimit", "operationAbortSignal",
      ...(options.tenantTelemetryRefKey === undefined ? [] : ["tenantTelemetryRefKey"])].sort());
    expect(profile).toEqual({ kind: "stopped-fleet-maintenance", fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" });
    expect(Object.isFrozen(profile)).toBe(true); return port;
  });
  state.dependencies.connectStoppedReplayMaintenance = connectStopped;
  return { ...state, port, stoppedClose, connectStopped };
}
async function expectStoppedReplayRejected(command: string, env: NodeJS.ProcessEnv,
  state = createStoppedReplayHarness()): Promise<void> {
  const read = vi.fn(async () => Buffer.alloc(32, 0x23)); state.dependencies.readRefKey = read;
  const failure = await runRestoreLedgerReconcileCli([command], env, state.dependencies).catch((error: unknown) => error);
  expect(formatRestoreLedgerReconcileCliError(failure)).toBe('{"status":"error","code":"invalid_configuration"}');
  expect(state.connectStore).not.toHaveBeenCalled(); expect(state.connectStopped).not.toHaveBeenCalled();
  expect(state.createAdapters).not.toHaveBeenCalled(); expect(state.loadJournalConfig).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled(); expect(state.output).toEqual([]);
}

describe("restore-ledger stopped-local replay role (synthetic orchestration, not native proof)", () => {
  it.each([undefined, "", "0", "true", 0, true])("rejects a malformed stopped-local flag before resources %#", async value => {
    const env = stoppedReplayEnv({ TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/stopped-key" });
    Object.defineProperty(env, "RESTORE_LEDGER_REPLAY_STOPPED_LOCAL_ACK", { value, enumerable: true, configurable: true });
    await expectStoppedReplayRejected("status", env);
  });
  it.each(["inherited", "hidden", "accessor"] as const)("requires an own enumerable data stopped-local flag: %s", async kind => {
    const env = stoppedReplayEnv(), getter = vi.fn(() => "1");
    if (kind === "inherited") {
      delete env.RESTORE_LEDGER_REPLAY_STOPPED_LOCAL_ACK;
      Object.setPrototypeOf(env, { RESTORE_LEDGER_REPLAY_STOPPED_LOCAL_ACK: "1" });
    } else Object.defineProperty(env, "RESTORE_LEDGER_REPLAY_STOPPED_LOCAL_ACK", kind === "hidden"
      ? { value: "1", enumerable: false, configurable: true } : { get: getter, enumerable: true, configurable: true });
    await expectStoppedReplayRejected("status", env); expect(getter).not.toHaveBeenCalled();
  });
  it.each(["activate-journal", "prepare", "activate-runtime", "abort", "run"])("does not authorize %s through the stopped-local replay flag", async command => {
    await expectStoppedReplayRejected(command, stoppedReplayEnv());
  });
  it.each([undefined, "0", ""]) ("requires the original exact fleet ACK even for stopped-local status %#", async value => {
    await expectStoppedReplayRejected("status", stoppedReplayEnv({ RESTORE_FLEET_STOPPED_ACK: value }));
  });
  it("does not invoke an accessor fleet ACK or NODE_ENV to decide the local role", async () => {
    for (const field of ["RESTORE_FLEET_STOPPED_ACK", "NODE_ENV"]) {
      const env = stoppedReplayEnv(), getter = vi.fn(() => field === "NODE_ENV" ? "test" : "1");
      Object.defineProperty(env, field, { get: getter, enumerable: true });
      await expectStoppedReplayRejected("status", env); expect(getter).not.toHaveBeenCalled();
    }
  });
  it("rejects production independently in passed environment and actual process", async () => {
    await expectStoppedReplayRejected("status", stoppedReplayEnv({ NODE_ENV: "production" }));
    const state = createStoppedReplayHarness();
    vi.stubEnv("NODE_ENV", "production");
    try { await expectStoppedReplayRejected("status", stoppedReplayEnv({ NODE_ENV: "test" }), state); }
    finally { vi.unstubAllEnvs(); }
  });
  it.each(["undefined", "hidden", "accessor"] as const)("rejects every own AUTHORITY key without evaluating it: %s", async kind => {
    const env = stoppedReplayEnv(), getter = vi.fn(() => "private-command");
    Object.defineProperty(env, "AUTHORITY_UNKNOWN", kind === "accessor" ? { get: getter, enumerable: true }
      : { value: undefined, enumerable: kind !== "hidden" });
    await expectStoppedReplayRejected("status", env); expect(getter).not.toHaveBeenCalled();
  });
  it("fails closed when the explicit narrow dependency is absent before reading a key", async () => {
    const state = createStoppedReplayHarness(); delete state.dependencies.connectStoppedReplayMaintenance;
    await expectStoppedReplayRejected("status", stoppedReplayEnv({ TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/stopped-key" }), state);
  });
  it.each([
    ["status", { MYSQL_URL: "not-mysql" }],
    ["verify", { RESTORE_RUN_ID: "not-a-run" }],
    ["replay-fences", { RESTORE_RUN_ID, RESTORE_REPLAY_PAGE_SIZE: "0" }],
  ] as const)("validates original %s settings before a stopped-local factory or adapter", async (command, extra) => {
    await expectStoppedReplayRejected(command, stoppedReplayEnv(extra));
  });
  it("keeps the default runtime profile when only other local or stopped ACKs are present", async () => {
    const state = createStoppedReplayHarness();
    await runRestoreLedgerReconcileCli(["status"], baseEnv({ RESTORE_FLEET_STOPPED_ACK: "1",
      BACKUP_ARTIFACT_LOCAL_ONLY_ACK: "1", BACKUP_CATALOG_PREPARE_RESTORE_STOPPED_LOCAL_ACK: "1" }), state.dependencies);
    expect(state.connectStore).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ maintenance: RUNTIME_PROFILE }));
    expect(state.connectStopped).not.toHaveBeenCalled();
  });
  it("replays through only the eight-method port and keeps stopped-local verify and status DB-only", async () => {
    const state = createStoppedReplayHarness();
    await activatePrimary(state); await state.delegate.publishRecord(record(91)); state.useRestoreEpoch();
    await runRestoreLedgerReconcileCli(["prepare"], restoreEnv(), state.dependencies);
    state.connectStore.mockClear(); state.loadJournalConfig.mockClear(); state.createAdapters.mockClear(); state.output.length = 0;
    const env = stoppedReplayEnv({ RESTORE_RUN_ID });
    await runRestoreLedgerReconcileCli(["replay-fences"], env, state.dependencies);
    expect((await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))?.entryCount).toBe(1);
    expect(state.createAdapters).toHaveBeenCalledOnce(); expect(state.adapter.validateStartup).toHaveBeenCalled();
    state.loadJournalConfig.mockClear(); state.createAdapters.mockClear();
    await runRestoreLedgerReconcileCli(["verify"], env, state.dependencies);
    await runRestoreLedgerReconcileCli(["status"], env, state.dependencies);
    expect((await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))?.phase).toBe("replay_sealed");
    expect(state.loadJournalConfig).not.toHaveBeenCalled(); expect(state.createAdapters).not.toHaveBeenCalled();
    expect(state.connectStore).not.toHaveBeenCalled(); expect(state.connectStopped).toHaveBeenCalledTimes(3);
    expect(state.connectStopped.mock.calls.map(([options]) => options.connectionLimit)).toEqual([2, 2, 1]);
    expect(Object.keys(state.port).sort()).toEqual(["getTenantRestoreJournalControl", "getTenantRestoreRuntimeControl",
      "getTenantRestoreReplayRun", "getTenantRestoreReplaySealedTargets", "recordTenantRestoreReplayFence",
      "sealTenantRestoreReplay", "getTenantRestoreReplayReceipt", "close"].sort());
    expect(state.stoppedClose).toHaveBeenCalledTimes(3);
    expect(state.output.map(line => JSON.parse(line).command)).toEqual(["replay-fences", "verify", "status"]);
  });
  it("joins an accepted late stopped-local factory and held actual close before wiping its key", async context => {
    const state = createStoppedReplayHarness(), key = Buffer.alloc(32, 0x57);
    state.dependencies.readRefKey = async () => key;
    let accept!: (signal: AbortSignal | undefined) => void, releaseFactory!: (port: StoppedReplayPort) => void;
    let closeEntered!: () => void, releaseClose!: () => void;
    const accepted = new Promise<AbortSignal | undefined>(resolve => { accept = resolve; });
    const rawFactory = new Promise<StoppedReplayPort>(resolve => { releaseFactory = resolve; });
    const closing = new Promise<void>(resolve => { closeEntered = resolve; });
    const rawClose = new Promise<void>(resolve => { releaseClose = resolve; });
    state.connectStopped.mockImplementation((options) => { accept(options.operationAbortSignal); return rawFactory; });
    state.stoppedClose.mockImplementation(() => { closeEntered(); return rawClose; });
    let done = false, rejected = false, error: unknown;
    const original = runRestoreLedgerReconcileCli(["status"], stoppedReplayEnv({ TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/stopped-key" }), state.dependencies);
    const settled = original.then(() => { done = true; }, reason => { done = true; rejected = true; error = reason; });
    const cancel = () => { process.emit("SIGTERM"); accept(undefined); releaseFactory(state.port); closeEntered(); releaseClose(); };
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      const signal = await accepted; expect(signal).toBeInstanceOf(AbortSignal);
      process.emit("SIGTERM"); expect(signal!.aborted).toBe(true);
      releaseFactory(state.port); await closing;
      expect(done).toBe(false); expect(key.every(byte => byte === 0x57)).toBe(true);
      releaseClose(); await settled;
      expect(rejected).toBe(true); expect(formatRestoreLedgerReconcileCliError(error)).toBe('{"status":"error","code":"operation_failed"}');
      expect(state.stoppedClose).toHaveBeenCalledOnce(); expect(key.every(byte => byte === 0)).toBe(true); expect(state.output).toEqual([]);
    } finally { context.signal.removeEventListener("abort", cancel); releaseFactory(state.port); releaseClose(); await settled; }
  });
  it("preserves an undefined original factory rejection while joining adapter close", async () => {
    const state = createStoppedReplayHarness(); state.connectStopped.mockRejectedValueOnce(undefined);
    state.adapter.close.mockRejectedValueOnce(new Error("later-adapter-close-failure"));
    let rejected = false;
    await runRestoreLedgerReconcileCli(["replay-fences"], stoppedReplayEnv({ RESTORE_RUN_ID }), state.dependencies).then(
      () => { throw Error("undefined factory rejection became success"); }, error => { rejected = true; expect(error).toBeUndefined(); });
    expect(rejected).toBe(true); expect(state.adapter.close).toHaveBeenCalledOnce(); expect(state.output).toEqual([]);
  });
  it("does not publish a status summary when actual stopped-local close rejects undefined", async () => {
    const state = createStoppedReplayHarness(), key = Buffer.alloc(32, 0x59);
    state.dependencies.readRefKey = async () => key; state.stoppedClose.mockRejectedValueOnce(undefined);
    let rejected = false;
    await runRestoreLedgerReconcileCli(["status"], stoppedReplayEnv({ TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/stopped-key" }), state.dependencies).then(
      () => { throw Error("undefined close rejection became success"); }, error => { rejected = true; expect(error).toBeUndefined(); });
    expect(rejected).toBe(true); expect(key.every(byte => byte === 0)).toBe(true); expect(state.output).toEqual([]);
  });
});
