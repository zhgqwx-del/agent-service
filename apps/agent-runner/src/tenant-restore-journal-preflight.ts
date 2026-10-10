import {
  TENANT_RESTORE_JOURNAL_PROTOCOL,
  tenantRestoreJournalTargetRootSha256,
  tenantRestoreReplaySealedTargetRootSha256,
  validateScanTenantRestoreJournalRecordsResult,
  validateTenantRestoreJournalControlRecord,
  validateTenantRestoreJournalRemoteHead,
  validateTenantRestoreJournalTargetDescriptor,
  validateTenantRestoreReplaySealedTarget,
  validateTenantRestoreRuntimeControlRecord,
  type AssertTenantRestoreRuntimeJournalEntryKnownInput,
  type AssertTenantRestoreRuntimeReadyInput,
  type ScanTenantRestoreJournalRecordsResult,
  type TenantRestoreJournalAdapter,
  type TenantRestoreJournalControlRecord,
  type TenantRestoreJournalRemoteEntry,
  type TenantRestoreJournalRemoteHead,
  type TenantRestoreJournalTargetDescriptor,
  type TenantRestoreReplaySealedTarget,
  type TenantRestoreRuntimeControlRecord,
} from "@agent-service/store";

export type TenantRestoreJournalPreflightErrorCode =
  | "invalid_configuration"
  | "missing_configuration"
  | "adapter_validation_failed"
  | "control_mismatch"
  | "runtime_not_ready"
  | "remote_chain_conflict"
  | "journal_entry_unknown"
  | "convergence_failed";

/** Content-free startup failure. Never attach a backend error, tenant, locator, or endpoint. */
export class TenantRestoreJournalPreflightError extends Error {
  constructor(readonly code: TenantRestoreJournalPreflightErrorCode) {
    super(`tenant restore journal preflight failed (${code})`);
    this.name = "TenantRestoreJournalPreflightError";
  }
}

export interface TenantRestoreJournalPreflightAdapter extends TenantRestoreJournalAdapter {
  /** Adapter-specific reachability, immutability, and conditional-create validation. */
  validateStartup(): Promise<void>;
}

/**
 * The physical adapter options deliberately stay outside this value. Only content-free identities
 * cross into the startup reconciler.
 */
export interface TenantRestoreJournalPreflightConfig {
  adapterProtocol: string;
  journalNamespaceSha256: string;
  logicalDatabaseNamespaceSha256: string;
  runtimeEpochSha256: string;
  targetRootSha256: string;
  targets: readonly { descriptor: TenantRestoreJournalTargetDescriptor }[];
}

export interface TenantRestoreJournalPreflightStore {
  getTenantRestoreJournalControl(): Promise<TenantRestoreJournalControlRecord>;
  getTenantRestoreJournalControlTargets(): Promise<TenantRestoreJournalTargetDescriptor[]>;
  getTenantRestoreRuntimeControl(): Promise<TenantRestoreRuntimeControlRecord>;
  getTenantRestoreRuntimeHeads(): Promise<TenantRestoreReplaySealedTarget[]>;
  assertTenantRestoreRuntimeJournalEntryKnown(
    input: AssertTenantRestoreRuntimeJournalEntryKnownInput,
  ): Promise<TenantRestoreRuntimeControlRecord>;
  assertTenantRestoreRuntimeReady(input: AssertTenantRestoreRuntimeReadyInput): Promise<void>;
}

export interface TenantRestoreJournalPreflightOptions {
  store: TenantRestoreJournalPreflightStore;
  config?: TenantRestoreJournalPreflightConfig;
  adapters?: readonly TenantRestoreJournalPreflightAdapter[];
  scanPageSize?: number;
  maxHeadRefreshes?: number;
  maxConcurrentRetries?: number;
}

export type TenantRestoreJournalPreflightSummary =
  | {
      state: "inactive";
      configured: boolean;
      targetCount: number;
      observedRecordCount: number;
      verifiedRecordCount: 0;
      runtimeControlGeneration: 0;
    }
  | {
      state: "ready";
      configured: true;
      targetCount: number;
      observedRecordCount: number;
      verifiedRecordCount: number;
      runtimeControlGeneration: number;
    };

interface PreflightBounds {
  scanPageSize: number;
  maxHeadRefreshes: number;
  maxConcurrentRetries: number;
}

interface ExternalTargetSnapshot {
  head: TenantRestoreJournalRemoteHead;
  sealedTarget: TenantRestoreReplaySealedTarget;
}

type ActiveJournalControl = Extract<
  TenantRestoreJournalControlRecord,
  { controlGeneration: 1 }
>;

const DEFAULT_SCAN_PAGE_SIZE = 100;
const DEFAULT_MAX_HEAD_REFRESHES = 16;
const DEFAULT_MAX_CONCURRENT_RETRIES = 16;

function fail(code: TenantRestoreJournalPreflightErrorCode): never {
  throw new TenantRestoreJournalPreflightError(code);
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  code: TenantRestoreJournalPreflightErrorCode,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function digest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function sameDescriptor(
  left: TenantRestoreJournalTargetDescriptor,
  right: TenantRestoreJournalTargetDescriptor,
): boolean {
  return left.targetOrdinal === right.targetOrdinal
    && left.targetSha256 === right.targetSha256
    && left.failureDomainSha256 === right.failureDomainSha256
    && left.adapterProtocol === right.adapterProtocol
    && left.journalNamespaceSha256 === right.journalNamespaceSha256;
}

function descriptorForAdapter(
  adapter: TenantRestoreJournalAdapter,
  targetOrdinal: number,
): TenantRestoreJournalTargetDescriptor {
  return {
    targetOrdinal,
    targetSha256: adapter.targetSha256,
    failureDomainSha256: adapter.failureDomainSha256,
    adapterProtocol: adapter.adapterProtocol,
    journalNamespaceSha256: adapter.journalNamespaceSha256,
  };
}

function sameSealedTarget(
  left: TenantRestoreReplaySealedTarget,
  right: TenantRestoreReplaySealedTarget,
): boolean {
  return sameDescriptor(left, right)
    && left.logicalDatabaseNamespaceSha256 === right.logicalDatabaseNamespaceSha256
    && left.sealedRemoteSequence === right.sealedRemoteSequence
    && left.sealedHeadRootSha256 === right.sealedHeadRootSha256;
}

function sameSealedTargets(
  left: readonly TenantRestoreReplaySealedTarget[],
  right: readonly TenantRestoreReplaySealedTarget[],
): boolean {
  return left.length === right.length
    && left.every((target, index) => sameSealedTarget(target, right[index]!));
}

function safeRecordCount(targets: readonly TenantRestoreReplaySealedTarget[]): number {
  let total = 0;
  for (const target of targets) {
    total += target.sealedRemoteSequence;
    if (!Number.isSafeInteger(total)) fail("remote_chain_conflict");
  }
  return total;
}

function normalizeConfig(
  config: TenantRestoreJournalPreflightConfig,
  adapters: readonly TenantRestoreJournalPreflightAdapter[],
): TenantRestoreJournalTargetDescriptor[] {
  try {
    if (adapters.length < 1
      || adapters.length > 32
      || config.targets.length !== adapters.length
      || !digest(config.journalNamespaceSha256)
      || !digest(config.logicalDatabaseNamespaceSha256)
      || !digest(config.runtimeEpochSha256)
      || !digest(config.targetRootSha256)) {
      throw new Error("invalid target count");
    }
    const descriptors = config.targets
      .map((target) => ({ ...target.descriptor }))
      .sort((left, right) => left.targetOrdinal - right.targetOrdinal);
    for (const [targetOrdinal, descriptor] of descriptors.entries()) {
      validateTenantRestoreJournalTargetDescriptor(descriptor);
      const adapter = adapters[targetOrdinal];
      if (!adapter
        || descriptor.targetOrdinal !== targetOrdinal
        || !sameDescriptor(descriptor, descriptorForAdapter(adapter, targetOrdinal))
        || descriptor.adapterProtocol !== config.adapterProtocol
        || descriptor.journalNamespaceSha256 !== config.journalNamespaceSha256
        || adapter.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256) {
        throw new Error("target identity mismatch");
      }
    }
    if (tenantRestoreJournalTargetRootSha256(descriptors) !== config.targetRootSha256) {
      throw new Error("target root mismatch");
    }
    return descriptors;
  } catch {
    fail("invalid_configuration");
  }
}

function assertActiveRuntimeMatches(
  runtime: TenantRestoreRuntimeControlRecord,
  control: Extract<TenantRestoreJournalControlRecord, { controlGeneration: 1 }>,
  config: TenantRestoreJournalPreflightConfig,
): asserts runtime is Extract<TenantRestoreRuntimeControlRecord, { state: "active" }> {
  try {
    validateTenantRestoreRuntimeControlRecord(runtime);
    if (runtime.state !== "active"
      || runtime.runtimeEpochSha256 !== config.runtimeEpochSha256
      || runtime.controlEvidenceSha256 !== control.evidenceSha256
      || runtime.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256
      || runtime.targetCount !== config.targets.length
      || runtime.targetRootSha256 !== config.targetRootSha256) {
      throw new Error("runtime identity mismatch");
    }
  } catch {
    fail("runtime_not_ready");
  }
}

function validateRuntimeHeads(
  heads: readonly TenantRestoreReplaySealedTarget[],
  runtime: Extract<TenantRestoreRuntimeControlRecord, { state: "active" }>,
  descriptors: readonly TenantRestoreJournalTargetDescriptor[],
  config: TenantRestoreJournalPreflightConfig,
): TenantRestoreReplaySealedTarget[] {
  try {
    const ordered = [...heads].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
    if (ordered.length !== descriptors.length) throw new Error("runtime head count mismatch");
    for (const [targetOrdinal, head] of ordered.entries()) {
      validateTenantRestoreReplaySealedTarget(head);
      const descriptor = descriptors[targetOrdinal];
      if (!descriptor
        || head.targetOrdinal !== targetOrdinal
        || !sameDescriptor(head, descriptor)
        || head.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256) {
        throw new Error("runtime head catalog mismatch");
      }
    }
    if (tenantRestoreReplaySealedTargetRootSha256(ordered)
      !== runtime.verifiedHeadRootSha256) {
      throw new Error("runtime head root mismatch");
    }
    return ordered;
  } catch {
    fail("runtime_not_ready");
  }
}

async function loadJournalControl(
  store: TenantRestoreJournalPreflightStore,
): Promise<TenantRestoreJournalControlRecord> {
  try {
    const control = await store.getTenantRestoreJournalControl();
    validateTenantRestoreJournalControlRecord(control);
    return control;
  } catch (error) {
    if (error instanceof TenantRestoreJournalPreflightError) throw error;
    fail("control_mismatch");
  }
}

async function loadRuntimeControl(
  store: TenantRestoreJournalPreflightStore,
): Promise<TenantRestoreRuntimeControlRecord> {
  try {
    const runtime = await store.getTenantRestoreRuntimeControl();
    validateTenantRestoreRuntimeControlRecord(runtime);
    return runtime;
  } catch (error) {
    if (error instanceof TenantRestoreJournalPreflightError) throw error;
    fail("runtime_not_ready");
  }
}

async function settleInactiveOrObserveActivation(
  store: TenantRestoreJournalPreflightStore,
  maxConcurrentRetries: number,
): Promise<{ state: "inactive" } | { state: "active"; control: ActiveJournalControl }> {
  for (let attempt = 0; attempt < maxConcurrentRetries; attempt += 1) {
    const before = await loadJournalControl(store);
    const runtime = await loadRuntimeControl(store);
    const after = await loadJournalControl(store);
    if (before.controlGeneration === 0 && after.controlGeneration === 0) {
      if (runtime.state !== "inactive") fail("runtime_not_ready");
      return { state: "inactive" };
    }
    if (before.controlGeneration === 1 && after.controlGeneration === 0) {
      fail("control_mismatch");
    }
    if (after.controlGeneration === 1) {
      if (before.controlGeneration === 1
        && before.evidenceSha256 !== after.evidenceSha256) {
        fail("control_mismatch");
      }
      if (runtime.state === "active") return { state: "active", control: after };
      // Activation can commit between the runtime and trailing control reads. Retry the complete
      // snapshot rather than incorrectly returning an inactive runner.
      if (before.controlGeneration === 0) continue;
      fail("runtime_not_ready");
    }
  }
  fail("convergence_failed");
}

function assertActiveControlMatches(
  control: TenantRestoreJournalControlRecord,
  catalog: readonly TenantRestoreJournalTargetDescriptor[],
  descriptors: readonly TenantRestoreJournalTargetDescriptor[],
  config: TenantRestoreJournalPreflightConfig,
): asserts control is Extract<TenantRestoreJournalControlRecord, { controlGeneration: 1 }> {
  try {
    if (control.controlGeneration !== 1
      || control.protocol !== TENANT_RESTORE_JOURNAL_PROTOCOL
      || control.adapterProtocol !== config.adapterProtocol
      || control.journalNamespaceSha256 !== config.journalNamespaceSha256
      || control.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256
      || control.targetCount !== descriptors.length
      || control.targetRootSha256 !== config.targetRootSha256) {
      throw new Error("journal control mismatch");
    }
    const ordered = [...catalog].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
    if (ordered.length !== descriptors.length
      || ordered.some((target, index) => !sameDescriptor(target, descriptors[index]!))
      || tenantRestoreJournalTargetRootSha256(ordered) !== config.targetRootSha256) {
      throw new Error("journal catalog mismatch");
    }
  } catch {
    fail("control_mismatch");
  }
}

async function readExternalTargets(
  adapters: readonly TenantRestoreJournalPreflightAdapter[],
  descriptors: readonly TenantRestoreJournalTargetDescriptor[],
  config: TenantRestoreJournalPreflightConfig,
  validateStartup: boolean,
): Promise<ExternalTargetSnapshot[]> {
  const snapshots: ExternalTargetSnapshot[] = [];
  for (const [targetOrdinal, adapter] of adapters.entries()) {
    try {
      const descriptor = descriptors[targetOrdinal];
      if (!descriptor
        || !sameDescriptor(descriptor, descriptorForAdapter(adapter, targetOrdinal))
        || adapter.logicalDatabaseNamespaceSha256
          !== config.logicalDatabaseNamespaceSha256) {
        throw new Error("adapter identity changed");
      }
      if (validateStartup) await adapter.validateStartup();
      const head = await adapter.readHead();
      validateTenantRestoreJournalRemoteHead(head);
      if (head.adapterProtocol !== descriptor.adapterProtocol
        || head.journalNamespaceSha256 !== descriptor.journalNamespaceSha256
        || head.targetSha256 !== descriptor.targetSha256
        || head.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256) {
        throw new Error("remote head identity mismatch");
      }
      const sealedTarget: TenantRestoreReplaySealedTarget = {
        ...descriptor,
        logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
        sealedRemoteSequence: head.remoteSequence,
        sealedHeadRootSha256: head.headRootSha256,
      };
      validateTenantRestoreReplaySealedTarget(sealedTarget);
      snapshots.push({ head, sealedTarget });
    } catch {
      fail(validateStartup ? "adapter_validation_failed" : "remote_chain_conflict");
    }
  }
  return snapshots;
}

async function loadAndValidateRuntimeHeads(
  store: TenantRestoreJournalPreflightStore,
  runtime: Extract<TenantRestoreRuntimeControlRecord, { state: "active" }>,
  descriptors: readonly TenantRestoreJournalTargetDescriptor[],
  config: TenantRestoreJournalPreflightConfig,
): Promise<TenantRestoreReplaySealedTarget[]> {
  try {
    const heads = await store.getTenantRestoreRuntimeHeads();
    return validateRuntimeHeads(heads, runtime, descriptors, config);
  } catch (error) {
    if (error instanceof TenantRestoreJournalPreflightError) throw error;
    fail("runtime_not_ready");
  }
}

async function assertEntryKnown(
  store: TenantRestoreJournalPreflightStore,
  entry: TenantRestoreJournalRemoteEntry,
  targetOrdinal: number,
  initialRuntime: Extract<TenantRestoreRuntimeControlRecord, { state: "active" }>,
  control: Extract<TenantRestoreJournalControlRecord, { controlGeneration: 1 }>,
  config: TenantRestoreJournalPreflightConfig,
  maxConcurrentRetries: number,
): Promise<Extract<TenantRestoreRuntimeControlRecord, { state: "active" }>> {
  let runtime = initialRuntime;
  for (let attempt = 0; attempt < maxConcurrentRetries; attempt += 1) {
    try {
      const advanced = await store.assertTenantRestoreRuntimeJournalEntryKnown({
        runtimeEpochSha256: config.runtimeEpochSha256,
        controlEvidenceSha256: control.evidenceSha256,
        expectedControlGeneration: runtime.controlGeneration,
        targetOrdinal,
        remoteEntry: entry,
      });
      assertActiveRuntimeMatches(advanced, control, config);
      if (advanced.controlGeneration < runtime.controlGeneration) {
        fail("runtime_not_ready");
      }
      return advanced;
    } catch (error) {
      if (error instanceof TenantRestoreJournalPreflightError) throw error;
      const refreshed = await loadRuntimeControl(store);
      assertActiveRuntimeMatches(refreshed, control, config);
      if (refreshed.controlGeneration === runtime.controlGeneration) {
        fail("journal_entry_unknown");
      }
      runtime = refreshed;
    }
  }
  fail("convergence_failed");
}

async function scanAndAssertKnown(
  store: TenantRestoreJournalPreflightStore,
  adapter: TenantRestoreJournalPreflightAdapter,
  snapshot: ExternalTargetSnapshot,
  checkpoint: TenantRestoreReplaySealedTarget,
  initialRuntime: Extract<TenantRestoreRuntimeControlRecord, { state: "active" }>,
  control: Extract<TenantRestoreJournalControlRecord, { controlGeneration: 1 }>,
  config: TenantRestoreJournalPreflightConfig,
  bounds: PreflightBounds,
): Promise<{
    runtime: Extract<TenantRestoreRuntimeControlRecord, { state: "active" }>;
    verifiedRecordCount: number;
  }> {
  if (checkpoint.sealedRemoteSequence > snapshot.head.remoteSequence) {
    fail("remote_chain_conflict");
  }
  if (checkpoint.sealedRemoteSequence === snapshot.head.remoteSequence) {
    if (checkpoint.sealedHeadRootSha256 !== snapshot.head.headRootSha256) {
      fail("remote_chain_conflict");
    }
    return { runtime: initialRuntime, verifiedRecordCount: 0 };
  }

  let afterRemoteSequence = checkpoint.sealedRemoteSequence;
  let afterHeadRootSha256 = checkpoint.sealedHeadRootSha256;
  let runtime = initialRuntime;
  let verifiedRecordCount = 0;
  while (afterRemoteSequence < snapshot.head.remoteSequence) {
    let page: ScanTenantRestoreJournalRecordsResult;
    const scanOptions = {
      sealedHead: snapshot.head,
      afterRemoteSequence,
      afterHeadRootSha256,
      limit: bounds.scanPageSize,
    };
    try {
      if (!sameDescriptor(
        snapshot.sealedTarget,
        descriptorForAdapter(adapter, checkpoint.targetOrdinal),
      ) || adapter.logicalDatabaseNamespaceSha256
        !== snapshot.sealedTarget.logicalDatabaseNamespaceSha256) {
        throw new Error("adapter identity changed");
      }
      page = await adapter.scanRecords(scanOptions);
      validateScanTenantRestoreJournalRecordsResult(scanOptions, page);
      if (page.entries.length === 0 && !page.complete) throw new Error("empty scan page");
    } catch {
      fail("remote_chain_conflict");
    }
    for (const entry of page.entries) {
      runtime = await assertEntryKnown(
        store,
        entry,
        checkpoint.targetOrdinal,
        runtime,
        control,
        config,
        bounds.maxConcurrentRetries,
      );
      verifiedRecordCount += 1;
      if (!Number.isSafeInteger(verifiedRecordCount)) fail("convergence_failed");
    }
    afterRemoteSequence = page.nextRemoteSequence;
    afterHeadRootSha256 = page.nextHeadRootSha256;
  }
  return { runtime, verifiedRecordCount };
}

async function runPreflight(
  options: TenantRestoreJournalPreflightOptions,
): Promise<TenantRestoreJournalPreflightSummary> {
  const adapters = Object.freeze([...(options.adapters ?? [])]);
  const bounds: PreflightBounds = {
    scanPageSize: boundedInteger(
      options.scanPageSize ?? DEFAULT_SCAN_PAGE_SIZE,
      1,
      1_000,
      "invalid_configuration",
    ),
    maxHeadRefreshes: boundedInteger(
      options.maxHeadRefreshes ?? DEFAULT_MAX_HEAD_REFRESHES,
      1,
      64,
      "invalid_configuration",
    ),
    maxConcurrentRetries: boundedInteger(
      options.maxConcurrentRetries ?? DEFAULT_MAX_CONCURRENT_RETRIES,
      1,
      64,
      "invalid_configuration",
    ),
  };
  let control = await loadJournalControl(options.store);

  if (!options.config) {
    if (adapters.length !== 0) fail("invalid_configuration");
    if (control.controlGeneration !== 0) fail("missing_configuration");
    const settled = await settleInactiveOrObserveActivation(
      options.store,
      bounds.maxConcurrentRetries,
    );
    if (settled.state === "active") fail("missing_configuration");
    return {
      state: "inactive",
      configured: false,
      targetCount: 0,
      observedRecordCount: 0,
      verifiedRecordCount: 0,
      runtimeControlGeneration: 0,
    };
  }

  const inputConfig = options.config;
  const descriptors = normalizeConfig(inputConfig, adapters);
  const config: TenantRestoreJournalPreflightConfig = Object.freeze({
    adapterProtocol: inputConfig.adapterProtocol,
    journalNamespaceSha256: inputConfig.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: inputConfig.logicalDatabaseNamespaceSha256,
    runtimeEpochSha256: inputConfig.runtimeEpochSha256,
    targetRootSha256: inputConfig.targetRootSha256,
    targets: Object.freeze(descriptors.map((descriptor) => Object.freeze({ descriptor }))),
  });
  let external = await readExternalTargets(adapters, descriptors, config, true);

  if (control.controlGeneration === 0) {
    const settled = await settleInactiveOrObserveActivation(
      options.store,
      bounds.maxConcurrentRetries,
    );
    if (settled.state === "inactive") {
      if (external.some((target) => target.sealedTarget.sealedRemoteSequence !== 0)) {
        fail("remote_chain_conflict");
      }
      return {
        state: "inactive",
        configured: true,
        targetCount: descriptors.length,
        observedRecordCount: 0,
        verifiedRecordCount: 0,
        runtimeControlGeneration: 0,
      };
    }
    control = settled.control;
  }

  let catalog: TenantRestoreJournalTargetDescriptor[];
  try {
    catalog = await options.store.getTenantRestoreJournalControlTargets();
  } catch {
    fail("control_mismatch");
  }
  assertActiveControlMatches(control, catalog, descriptors, config);

  let verifiedRecordCount = 0;
  refreshLoop: for (let refresh = 0; refresh < bounds.maxHeadRefreshes; refresh += 1) {
    let runtime = await loadRuntimeControl(options.store);
    assertActiveRuntimeMatches(runtime, control, config);
    const checkpoints = await loadAndValidateRuntimeHeads(
      options.store,
      runtime,
      descriptors,
      config,
    );

    for (const [targetOrdinal, checkpoint] of checkpoints.entries()) {
      const snapshot = external[targetOrdinal];
      const adapter = adapters[targetOrdinal];
      if (!snapshot || !adapter) fail("invalid_configuration");
      if (checkpoint.sealedRemoteSequence > snapshot.head.remoteSequence) {
        external = await readExternalTargets(adapters, descriptors, config, false);
        if (checkpoint.sealedRemoteSequence
          > external[targetOrdinal]!.head.remoteSequence) {
          fail("remote_chain_conflict");
        }
        continue refreshLoop;
      }
      const scanned = await scanAndAssertKnown(
        options.store,
        adapter,
        snapshot,
        checkpoint,
        runtime,
        control,
        config,
        bounds,
      );
      runtime = scanned.runtime;
      verifiedRecordCount += scanned.verifiedRecordCount;
      if (!Number.isSafeInteger(verifiedRecordCount)) fail("convergence_failed");
    }

    const refreshedExternal = await readExternalTargets(adapters, descriptors, config, false);
    if (!sameSealedTargets(
      external.map((target) => target.sealedTarget),
      refreshedExternal.map((target) => target.sealedTarget),
    )) {
      external = refreshedExternal;
      continue;
    }

    const finalRuntime = await loadRuntimeControl(options.store);
    assertActiveRuntimeMatches(finalRuntime, control, config);
    const finalHeads = await loadAndValidateRuntimeHeads(
      options.store,
      finalRuntime,
      descriptors,
      config,
    );
    const observedHeads = external.map((target) => target.sealedTarget);
    if (!sameSealedTargets(finalHeads, observedHeads)) {
      if (finalHeads.some((head, index) => (
        head.sealedRemoteSequence > observedHeads[index]!.sealedRemoteSequence
      ))) fail("remote_chain_conflict");
      continue;
    }
    try {
      await options.store.assertTenantRestoreRuntimeReady({
        runtimeEpochSha256: config.runtimeEpochSha256,
        controlEvidenceSha256: control.evidenceSha256,
        observedHeads,
      });
    } catch {
      fail("runtime_not_ready");
    }
    const postReadyControl = await loadJournalControl(options.store);
    if (postReadyControl.controlGeneration !== 1
      || postReadyControl.evidenceSha256 !== control.evidenceSha256) {
      fail("control_mismatch");
    }
    const postReadyRuntime = await loadRuntimeControl(options.store);
    assertActiveRuntimeMatches(postReadyRuntime, control, config);
    const postReadyHeads = await loadAndValidateRuntimeHeads(
      options.store,
      postReadyRuntime,
      descriptors,
      config,
    );
    if (!sameSealedTargets(postReadyHeads, observedHeads)) fail("runtime_not_ready");
    const postReadyExternal = await readExternalTargets(
      adapters,
      descriptors,
      config,
      false,
    );
    if (!sameSealedTargets(
      postReadyExternal.map((target) => target.sealedTarget),
      observedHeads,
    )) {
      external = postReadyExternal;
      continue;
    }
    return {
      state: "ready",
      configured: true,
      targetCount: descriptors.length,
      observedRecordCount: safeRecordCount(observedHeads),
      verifiedRecordCount,
      runtimeControlGeneration: postReadyRuntime.controlGeneration,
    };
  }
  fail("convergence_failed");
}

/**
 * Validate configured independent targets and reconcile durable runtime checkpoints before the
 * runner may serve traffic. All unexpected dependency failures collapse to one content-free code.
 */
export async function reconcileTenantRestoreJournalRuntimeForStartup(
  options: TenantRestoreJournalPreflightOptions,
): Promise<TenantRestoreJournalPreflightSummary> {
  try {
    return await runPreflight(options);
  } catch (error) {
    if (error instanceof TenantRestoreJournalPreflightError) throw error;
    fail("runtime_not_ready");
  }
}
