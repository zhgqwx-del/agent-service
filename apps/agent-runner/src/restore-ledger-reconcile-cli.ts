import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  EMPTY_TENANT_RESTORE_RUNTIME_CONTROL_EVIDENCE_SHA256,
  MysqlSessionStore,
  TENANT_RESTORE_JOURNAL_PROTOCOL,
  TenantRestoreJournalConflictError,
  TenantRestoreJournalCorruptError,
  tenantRestoreJournalTargetRootSha256,
  tenantRestoreReplaySealedTargetRootSha256,
  validateScanTenantRestoreJournalRecordsResult,
  validateTenantRestoreJournalControlRecord,
  validateTenantRestoreJournalRemoteHead,
  validateTenantRestoreReplayReceipt,
  validateTenantRestoreReplayRunRecord,
  validateTenantRestoreReplaySealedTarget,
  validateTenantRestoreRuntimeControlRecord,
  type RestoreReplayStore,
  type TenantRestoreJournalAdapter,
  type TenantRestoreJournalControlRecord,
  type TenantRestoreJournalStore,
  type TenantRestoreJournalTargetDescriptor,
  type TenantRestoreReplayRunRecord,
  type TenantRestoreReplaySealedTarget,
  type TenantRestoreRuntimeControlRecord,
} from "@agent-service/store";
import { z } from "zod";
import {
  createTenantRestoreJournalAdapters,
  loadTenantRestoreJournalConfig,
  type TenantRestoreJournalRuntimeConfig,
} from "./tenant-restore-journal-config.js";

const COMMANDS = [
  "status",
  "activate-journal",
  "prepare",
  "replay-fences",
  "verify",
  "activate-runtime",
  "abort",
  "run",
] as const;
type RestoreLedgerCommand = (typeof COMMANDS)[number];

const RESTORE_RUN_ID =
  /^restore_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_PAGE_SIZE = 100;

type RestoreLedgerCliErrorCode =
  | "invalid_command"
  | "invalid_configuration"
  | "invalid_durable_state"
  | "journal_conflict"
  | "journal_corrupt"
  | "journal_not_empty"
  | "runtime_head_changed"
  | "runtime_head_changed_forward_fix_required"
  | "operation_failed";

class RestoreLedgerCliError extends Error {
  constructor(readonly code: RestoreLedgerCliErrorCode) {
    super(code);
    this.name = "RestoreLedgerCliError";
  }
}

type ReconcileStore = TenantRestoreJournalStore & RestoreReplayStore & {
  close(): Promise<void>;
};

interface ReconcileAdapter extends TenantRestoreJournalAdapter {
  validateStartup(): Promise<void>;
}

export interface RestoreLedgerReconcileCliDependencies {
  connectStore(options: {
    url: string;
    connectionLimit: number;
    migrationMode: "verify";
  }): Promise<ReconcileStore>;
  loadJournalConfig(
    env: NodeJS.ProcessEnv,
    context: { production: boolean; store: "mysql"; blobS3Bucket?: string },
  ): TenantRestoreJournalRuntimeConfig | undefined;
  createAdapters(config: TenantRestoreJournalRuntimeConfig): readonly ReconcileAdapter[];
  writeLine(line: string): void;
}

const MysqlEnv = z.object({
  MYSQL_URL: z.string().min(1).max(4_096).refine((value) => {
    if (value.trim() !== value) return false;
    try {
      return new URL(value).protocol === "mysql:";
    } catch {
      return false;
    }
  }),
});

const RestoreRunEnv = z.object({
  RESTORE_RUN_ID: z.string().regex(RESTORE_RUN_ID),
  RESTORE_FLEET_STOPPED_ACK: z.literal("1"),
});

const PrepareEnv = RestoreRunEnv.extend({
  SOURCE_BACKUP_SHA256: z.string().regex(SHA256),
});

const S3BucketName = z.string().min(3).max(63).refine((value) => (
  /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)
  && !value.includes("..")
  && !value.includes(".-")
  && !value.includes("-.")
  && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
), "bucket must be a safe DNS-style name");

const PrimaryActivationBaseEnv = z.object({
  RESTORE_JOURNAL_PRIMARY_ACTIVATION_ACK: z.literal("1"),
  RESTORE_FLEET_STOPPED_ACK: z.literal("1"),
  RESTORE_JOURNAL_S3_BUCKET: S3BucketName,
});

const PrimaryActivationEnv = z.discriminatedUnion("BLOB_STORE", [
  PrimaryActivationBaseEnv.extend({
    BLOB_STORE: z.literal("filesystem"),
  }),
  PrimaryActivationBaseEnv.extend({
    BLOB_STORE: z.literal("s3"),
    BLOB_S3_BUCKET: S3BucketName,
  }),
]).superRefine((value, context) => {
  if (value.BLOB_STORE === "s3"
    && value.BLOB_S3_BUCKET === value.RESTORE_JOURNAL_S3_BUCKET) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["BLOB_S3_BUCKET"],
      message: "restore journal and Blob buckets must be distinct",
    });
  }
});

const DEFAULT_DEPENDENCIES: RestoreLedgerReconcileCliDependencies = {
  connectStore: (options) => MysqlSessionStore.connect({
    url: options.url,
    connectionLimit: options.connectionLimit,
    migrationMode: options.migrationMode,
  }),
  loadJournalConfig: (env, context) => loadTenantRestoreJournalConfig(env, context),
  createAdapters: (config) => createTenantRestoreJournalAdapters(config),
  writeLine: (line) => process.stdout.write(`${line}\n`),
};

function cliError(code: RestoreLedgerCliErrorCode): RestoreLedgerCliError {
  return new RestoreLedgerCliError(code);
}

function parseCommand(argv: readonly string[]): RestoreLedgerCommand {
  if (argv.length !== 1 || !(COMMANDS as readonly string[]).includes(argv[0]!)) {
    throw cliError("invalid_command");
  }
  return argv[0] as RestoreLedgerCommand;
}

function parsePageSize(env: NodeJS.ProcessEnv): number {
  const raw = env.RESTORE_REPLAY_PAGE_SIZE;
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  if (!/^[1-9][0-9]*$/.test(raw)) throw cliError("invalid_configuration");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw cliError("invalid_configuration");
  }
  return value;
}

function descriptorCatalog(
  config: TenantRestoreJournalRuntimeConfig,
): TenantRestoreJournalTargetDescriptor[] {
  const descriptors = config.targets
    .map((target) => ({ ...target.descriptor }))
    .sort((left, right) => left.targetOrdinal - right.targetOrdinal);
  if (tenantRestoreJournalTargetRootSha256(descriptors) !== config.targetRootSha256) {
    throw cliError("invalid_configuration");
  }
  return descriptors;
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

function controlMatchesConfig(
  control: TenantRestoreJournalControlRecord,
  config: TenantRestoreJournalRuntimeConfig,
): control is Extract<TenantRestoreJournalControlRecord, { controlGeneration: 1 }> {
  return control.controlGeneration === 1
    && control.adapterProtocol === config.adapterProtocol
    && control.journalNamespaceSha256 === config.journalNamespaceSha256
    && control.logicalDatabaseNamespaceSha256 === config.logicalDatabaseNamespaceSha256
    && control.targetCount === config.targets.length
    && control.targetRootSha256 === config.targetRootSha256;
}

function runtimeMatchesConfig(
  runtime: TenantRestoreRuntimeControlRecord,
  control: Extract<TenantRestoreJournalControlRecord, { controlGeneration: 1 }>,
  config: TenantRestoreJournalRuntimeConfig,
): runtime is Extract<TenantRestoreRuntimeControlRecord, { state: "active" }> {
  return runtime.state === "active"
    && runtime.runtimeEpochSha256 === config.runtimeEpochSha256
    && runtime.controlEvidenceSha256 === control.evidenceSha256
    && runtime.logicalDatabaseNamespaceSha256 === config.logicalDatabaseNamespaceSha256
    && runtime.targetCount === config.targets.length
    && runtime.targetRootSha256 === config.targetRootSha256;
}

function invalidDurableState(): never {
  throw cliError("invalid_durable_state");
}

function validateAsDurableState(operation: () => void): void {
  try {
    operation();
  } catch {
    invalidDurableState();
  }
}

function receiptExactlyMatchesRun(
  run: TenantRestoreReplayRunRecord,
  receipt: NonNullable<Awaited<ReturnType<RestoreReplayStore["getTenantRestoreReplayReceipt"]>>>,
): boolean {
  return (run.phase === "replay_sealed" || run.phase === "active")
    && receipt.restoreRunId === run.restoreRunId
    && receipt.sourceBackupSha256 === run.sourceBackupSha256
    && receipt.runtimeEpochSha256 === run.runtimeEpochSha256
    && receipt.controlEvidenceSha256 === run.controlEvidenceSha256
    && receipt.protocol === run.protocol
    && receipt.adapterProtocol === run.adapterProtocol
    && receipt.journalNamespaceSha256 === run.journalNamespaceSha256
    && receipt.logicalDatabaseNamespaceSha256 === run.logicalDatabaseNamespaceSha256
    && receipt.targetCount === run.targetCount
    && receipt.targetRootSha256 === run.targetRootSha256
    && receipt.sealedTargetRootSha256 === run.sealedTargetRootSha256
    && receipt.entryCount === run.entryCount
    && receipt.entryRootSha256 === run.entryRootSha256
    && receipt.fenceCount === run.fenceCount
    && receipt.fenceRootSha256 === run.fenceRootSha256
    && receipt.storeDbTimestampMs === run.sealedAtDbMs
    && receipt.receiptSha256 === run.terminalReceiptSha256;
}

async function readExternalHeads(
  config: TenantRestoreJournalRuntimeConfig,
  adapters: readonly ReconcileAdapter[],
  validateStartup: boolean,
): Promise<TenantRestoreReplaySealedTarget[]> {
  const descriptors = descriptorCatalog(config);
  if (adapters.length !== descriptors.length) throw cliError("invalid_configuration");
  const heads: TenantRestoreReplaySealedTarget[] = [];
  for (const [targetOrdinal, adapter] of adapters.entries()) {
    const descriptor = descriptors[targetOrdinal];
    if (!descriptor
      || !sameDescriptor(descriptor, {
        targetOrdinal,
        targetSha256: adapter.targetSha256,
        failureDomainSha256: adapter.failureDomainSha256,
        adapterProtocol: adapter.adapterProtocol,
        journalNamespaceSha256: adapter.journalNamespaceSha256,
      })
      || adapter.logicalDatabaseNamespaceSha256
        !== config.logicalDatabaseNamespaceSha256) {
      throw cliError("invalid_configuration");
    }
    if (validateStartup) await adapter.validateStartup();
    const head = await adapter.readHead();
    validateTenantRestoreJournalRemoteHead(head);
    if (head.adapterProtocol !== descriptor.adapterProtocol
      || head.journalNamespaceSha256 !== descriptor.journalNamespaceSha256
      || head.targetSha256 !== descriptor.targetSha256
      || head.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256) {
      throw cliError("journal_conflict");
    }
    const sealed: TenantRestoreReplaySealedTarget = {
      ...descriptor,
      logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
      sealedRemoteSequence: head.remoteSequence,
      sealedHeadRootSha256: head.headRootSha256,
    };
    validateTenantRestoreReplaySealedTarget(sealed);
    heads.push(sealed);
  }
  return heads;
}

async function assertPrimaryActivationCommitted(
  store: ReconcileStore,
  config: TenantRestoreJournalRuntimeConfig,
  adapters: readonly ReconcileAdapter[],
  observedHeads: readonly TenantRestoreReplaySealedTarget[],
): Promise<void> {
  const control = await store.getTenantRestoreJournalControl().catch(invalidDurableState);
  const runtime = await store.getTenantRestoreRuntimeControl().catch(invalidDurableState);
  const targets = await store.getTenantRestoreJournalControlTargets().catch(invalidDurableState);
  const durableHeads = await store.getTenantRestoreRuntimeHeads().catch(invalidDurableState);
  validateAsDurableState(() => {
    validateTenantRestoreJournalControlRecord(control);
    validateTenantRestoreRuntimeControlRecord(runtime);
  });
  const configuredTargets = descriptorCatalog(config);
  if (!controlMatchesConfig(control, config)
    || runtime.state !== "active"
    || runtime.lineageKind !== "primary"
    || runtime.runtimeEpochSha256 !== config.runtimeEpochSha256
    || runtime.controlEvidenceSha256 !== control.evidenceSha256
    || runtime.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256
    || runtime.targetCount !== configuredTargets.length
    || runtime.targetRootSha256 !== config.targetRootSha256
    || targets.length !== configuredTargets.length
    || targets.some((target, index) => !sameDescriptor(target, configuredTargets[index]!))) {
    invalidDurableState();
  }
  if (!sameSealedTargets(durableHeads, observedHeads)) {
    throw cliError("runtime_head_changed_forward_fix_required");
  }
  const postCommitExternalHeads = await readExternalHeads(config, adapters, false);
  if (!sameSealedTargets(postCommitExternalHeads, observedHeads)) {
    throw cliError("runtime_head_changed_forward_fix_required");
  }
  if (runtime.updateKind !== "primary_activation"
    || runtime.controlGeneration !== 1
    || runtime.verifiedHeadRootSha256
      !== tenantRestoreReplaySealedTargetRootSha256(observedHeads)
    || runtime.previousControlEvidenceSha256
      !== EMPTY_TENANT_RESTORE_RUNTIME_CONTROL_EVIDENCE_SHA256
    || runtime.activatedAtDbMs !== runtime.updatedAtDbMs) {
    invalidDurableState();
  }
}

async function assertRestoreActivationCommitted(
  store: ReconcileStore,
  config: TenantRestoreJournalRuntimeConfig,
  adapters: readonly ReconcileAdapter[],
  restoreRunId: string,
  sealedTargets: readonly TenantRestoreReplaySealedTarget[],
  previousRuntime?: TenantRestoreRuntimeControlRecord,
): Promise<TenantRestoreReplayRunRecord> {
  const control = await store.getTenantRestoreJournalControl().catch(invalidDurableState);
  const run = await store.getTenantRestoreReplayRun(restoreRunId).catch(invalidDurableState);
  const receipt = await store.getTenantRestoreReplayReceipt(restoreRunId).catch(invalidDurableState);
  const runtime = await store.getTenantRestoreRuntimeControl().catch(invalidDurableState);
  const durableHeads = await store.getTenantRestoreRuntimeHeads().catch(invalidDurableState);
  if (!run || !receipt) invalidDurableState();
  validateAsDurableState(() => {
    validateTenantRestoreJournalControlRecord(control);
    validateTenantRestoreReplayRunRecord(run);
    validateTenantRestoreReplayReceipt(receipt);
    validateTenantRestoreRuntimeControlRecord(runtime);
    for (const target of sealedTargets) validateTenantRestoreReplaySealedTarget(target);
  });
  const sealedTargetRootSha256 = tenantRestoreReplaySealedTargetRootSha256(sealedTargets);
  if (!controlMatchesConfig(control, config)
    || run.phase !== "active"
    || run.restoreRunId !== restoreRunId
    || run.runtimeEpochSha256 !== config.runtimeEpochSha256
    || run.controlEvidenceSha256 !== control.evidenceSha256
    || run.adapterProtocol !== config.adapterProtocol
    || run.journalNamespaceSha256 !== config.journalNamespaceSha256
    || run.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256
    || run.targetCount !== config.targets.length
    || run.targetRootSha256 !== config.targetRootSha256
    || run.sealedTargetRootSha256 !== sealedTargetRootSha256
    || !receiptExactlyMatchesRun(run, receipt)
    || runtime.state !== "active"
    || runtime.lineageKind !== "restore"
    || runtime.restoreRunId !== restoreRunId
    || runtime.replayReceiptSha256 !== receipt.receiptSha256
    || runtime.runtimeEpochSha256 !== config.runtimeEpochSha256
    || runtime.controlEvidenceSha256 !== control.evidenceSha256
    || runtime.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256
    || runtime.targetCount !== config.targets.length
    || runtime.targetRootSha256 !== config.targetRootSha256) {
    invalidDurableState();
  }
  if (!sameSealedTargets(durableHeads, sealedTargets)) {
    throw cliError("runtime_head_changed_forward_fix_required");
  }
  const postCommitExternalHeads = await readExternalHeads(config, adapters, false);
  if (!sameSealedTargets(postCommitExternalHeads, sealedTargets)) {
    throw cliError("runtime_head_changed_forward_fix_required");
  }
  if (runtime.updateKind !== "restore_activation"
    || runtime.verifiedHeadRootSha256 !== sealedTargetRootSha256
    || runtime.activatedAtDbMs !== run.activatedAtDbMs) {
    invalidDurableState();
  }
  if (previousRuntime !== undefined) {
    const previousEvidenceSha256 = previousRuntime.state === "active"
      ? previousRuntime.evidenceSha256
      : EMPTY_TENANT_RESTORE_RUNTIME_CONTROL_EVIDENCE_SHA256;
    if (runtime.controlGeneration !== previousRuntime.controlGeneration + 1
      || runtime.previousControlEvidenceSha256 !== previousEvidenceSha256) {
      invalidDurableState();
    }
  }
  return run;
}

function exactPreparedRun(
  run: TenantRestoreReplayRunRecord | null,
  input: {
    restoreRunId: string;
    sourceBackupSha256: string;
    runtimeEpochSha256: string;
    controlEvidenceSha256: string;
    sealedTargets: readonly TenantRestoreReplaySealedTarget[];
  },
): run is TenantRestoreReplayRunRecord {
  if (!run) return false;
  validateTenantRestoreReplayRunRecord(run);
  const first = input.sealedTargets[0];
  if (!first) return false;
  const descriptors = input.sealedTargets.map((target) => ({
    targetOrdinal: target.targetOrdinal,
    targetSha256: target.targetSha256,
    failureDomainSha256: target.failureDomainSha256,
    adapterProtocol: target.adapterProtocol,
    journalNamespaceSha256: target.journalNamespaceSha256,
  }));
  const expectedEntryCount = input.sealedTargets.reduce(
    (total, target) => total + target.sealedRemoteSequence,
    0,
  );
  return run.restoreRunId === input.restoreRunId
    && run.sourceBackupSha256 === input.sourceBackupSha256
    && run.runtimeEpochSha256 === input.runtimeEpochSha256
    && run.controlEvidenceSha256 === input.controlEvidenceSha256
    && run.protocol === TENANT_RESTORE_JOURNAL_PROTOCOL
    && run.adapterProtocol === first.adapterProtocol
    && run.journalNamespaceSha256 === first.journalNamespaceSha256
    && run.logicalDatabaseNamespaceSha256 === first.logicalDatabaseNamespaceSha256
    && run.targetCount === input.sealedTargets.length
    && run.targetRootSha256 === tenantRestoreJournalTargetRootSha256(descriptors)
    && run.sealedTargetRootSha256
      === tenantRestoreReplaySealedTargetRootSha256(input.sealedTargets)
    && run.expectedEntryCount === expectedEntryCount;
}

async function prepareRestore(
  store: ReconcileStore,
  config: TenantRestoreJournalRuntimeConfig,
  adapters: readonly ReconcileAdapter[],
  env: NodeJS.ProcessEnv,
): Promise<TenantRestoreReplayRunRecord> {
  const settings = PrepareEnv.parse(env);
  const control = await store.getTenantRestoreJournalControl();
  validateTenantRestoreJournalControlRecord(control);
  if (!controlMatchesConfig(control, config)) throw cliError("invalid_durable_state");
  const currentRuntime = await store.getTenantRestoreRuntimeControl();
  validateTenantRestoreRuntimeControlRecord(currentRuntime);
  if (currentRuntime.state !== "active"
    || currentRuntime.controlEvidenceSha256 !== control.evidenceSha256
    || currentRuntime.logicalDatabaseNamespaceSha256
      !== config.logicalDatabaseNamespaceSha256
    || currentRuntime.targetRootSha256 !== config.targetRootSha256
    || currentRuntime.runtimeEpochSha256 === config.runtimeEpochSha256) {
    throw cliError("invalid_durable_state");
  }
  const sealedTargets = await readExternalHeads(config, adapters, false);
  const input = {
    restoreRunId: settings.RESTORE_RUN_ID,
    sourceBackupSha256: settings.SOURCE_BACKUP_SHA256,
    runtimeEpochSha256: config.runtimeEpochSha256,
    controlEvidenceSha256: control.evidenceSha256,
    sealedTargets,
  };
  try {
    return await store.prepareTenantRestoreReplay(input);
  } catch (error) {
    const committed = await store.getTenantRestoreReplayRun(settings.RESTORE_RUN_ID).catch(() => null);
    if (exactPreparedRun(committed, input)) {
      const durableTargets = await store
        .getTenantRestoreReplaySealedTargets(settings.RESTORE_RUN_ID)
        .catch(() => []);
      if (sameSealedTargets(durableTargets, sealedTargets)) return committed;
    }
    throw error;
  }
}

async function replayFences(
  store: ReconcileStore,
  config: TenantRestoreJournalRuntimeConfig,
  adapters: readonly ReconcileAdapter[],
  env: NodeJS.ProcessEnv,
): Promise<TenantRestoreReplayRunRecord> {
  const settings = RestoreRunEnv.parse(env);
  const run = await store.getTenantRestoreReplayRun(settings.RESTORE_RUN_ID);
  if (!run) throw cliError("invalid_durable_state");
  validateTenantRestoreReplayRunRecord(run);
  if (run.phase !== "prepared"
    || run.runtimeEpochSha256 !== config.runtimeEpochSha256
    || run.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256
    || run.targetRootSha256 !== config.targetRootSha256) {
    throw cliError("invalid_durable_state");
  }
  const sealedTargets = await store.getTenantRestoreReplaySealedTargets(settings.RESTORE_RUN_ID);
  if (sealedTargets.length !== adapters.length) throw cliError("invalid_durable_state");
  const pageSize = parsePageSize(env);
  for (const [targetOrdinal, sealedTarget] of sealedTargets.entries()) {
    const adapter = adapters[targetOrdinal];
    const configured = config.targets[targetOrdinal]?.descriptor;
    if (!adapter || !configured || !sameDescriptor(sealedTarget, configured)) {
      throw cliError("invalid_durable_state");
    }
    let sequence = 0;
    let root = EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256;
    while (sequence < sealedTarget.sealedRemoteSequence) {
      const scanOptions = {
        sealedHead: {
          scope: "tenant-restore-journal-remote-head-v1" as const,
          protocol: "tenant-restore-journal-v1" as const,
          adapterProtocol: sealedTarget.adapterProtocol,
          journalNamespaceSha256: sealedTarget.journalNamespaceSha256,
          targetSha256: sealedTarget.targetSha256,
          logicalDatabaseNamespaceSha256: sealedTarget.logicalDatabaseNamespaceSha256,
          remoteSequence: sealedTarget.sealedRemoteSequence,
          headRootSha256: sealedTarget.sealedHeadRootSha256,
        },
        afterRemoteSequence: sequence,
        afterHeadRootSha256: root,
        limit: pageSize,
      };
      const page = await adapter.scanRecords(scanOptions);
      validateScanTenantRestoreJournalRecordsResult(scanOptions, page);
      if (page.entries.length === 0 && !page.complete) throw cliError("journal_corrupt");
      for (const entry of page.entries) {
        const input = {
          restoreRunId: settings.RESTORE_RUN_ID,
          targetOrdinal,
          remoteEntry: entry,
        };
        let recorded;
        try {
          recorded = await store.recordTenantRestoreReplayFence(input);
        } catch (firstError) {
          // The durable operation is exact-idempotent. One immediate replay closes the common
          // committed-response-loss window; if it cannot prove the same entry, preserve failure.
          try {
            recorded = await store.recordTenantRestoreReplayFence(input);
          } catch {
            throw firstError;
          }
        }
        if (!recorded) throw cliError("operation_failed");
      }
      sequence = page.nextRemoteSequence;
      root = page.nextHeadRootSha256;
    }
  }
  const updated = await store.getTenantRestoreReplayRun(settings.RESTORE_RUN_ID);
  if (!updated) throw cliError("invalid_durable_state");
  validateTenantRestoreReplayRunRecord(updated);
  return updated;
}

async function verifyRestore(
  store: ReconcileStore,
  env: NodeJS.ProcessEnv,
): Promise<TenantRestoreReplayRunRecord> {
  const settings = RestoreRunEnv.parse(env);
  let receipt: NonNullable<Awaited<ReturnType<RestoreReplayStore["getTenantRestoreReplayReceipt"]>>>;
  try {
    const sealed = await store.sealTenantRestoreReplay(settings.RESTORE_RUN_ID);
    if (!sealed) throw cliError("invalid_durable_state");
    validateTenantRestoreReplayReceipt(sealed);
    receipt = sealed;
  } catch (error) {
    const committed = await store.getTenantRestoreReplayReceipt(settings.RESTORE_RUN_ID)
      .catch(() => null);
    if (!committed) throw error;
    validateTenantRestoreReplayReceipt(committed);
    receipt = committed;
  }
  const run = await store.getTenantRestoreReplayRun(settings.RESTORE_RUN_ID);
  if (!run || (run.phase !== "replay_sealed" && run.phase !== "active")) {
    throw cliError("invalid_durable_state");
  }
  validateTenantRestoreReplayRunRecord(run);
  if (!receiptExactlyMatchesRun(run, receipt)) throw cliError("invalid_durable_state");
  return run;
}

async function activateRuntime(
  store: ReconcileStore,
  config: TenantRestoreJournalRuntimeConfig,
  adapters: readonly ReconcileAdapter[],
  env: NodeJS.ProcessEnv,
): Promise<TenantRestoreReplayRunRecord> {
  const settings = RestoreRunEnv.parse(env);
  let run = await store.getTenantRestoreReplayRun(settings.RESTORE_RUN_ID);
  if (!run || (run.phase !== "replay_sealed" && run.phase !== "active")) {
    throw cliError("invalid_durable_state");
  }
  validateTenantRestoreReplayRunRecord(run);
  const sealedTargets = await store.getTenantRestoreReplaySealedTargets(settings.RESTORE_RUN_ID);
  const currentHeads = await readExternalHeads(config, adapters, false);
  if (!sameSealedTargets(sealedTargets, currentHeads)) throw cliError("runtime_head_changed");
  const before = await store.getTenantRestoreRuntimeControl();
  validateTenantRestoreRuntimeControlRecord(before);
  if (run.phase === "active") {
    return assertRestoreActivationCommitted(
      store,
      config,
      adapters,
      settings.RESTORE_RUN_ID,
      sealedTargets,
    );
  }
  try {
    await store.activateTenantRestoreRuntime({
      restoreRunId: settings.RESTORE_RUN_ID,
      expectedControlGeneration: before.controlGeneration,
    });
  } catch {
    // Do not infer success from a handful of discriminator fields. The exact committed-state read
    // below independently binds the run, terminal receipt, journal control, runtime event,
    // durable heads and a fresh external head snapshot.
  }
  return assertRestoreActivationCommitted(
    store,
    config,
    adapters,
    settings.RESTORE_RUN_ID,
    sealedTargets,
    before,
  );
}

async function activatePrimaryJournal(
  store: ReconcileStore,
  config: TenantRestoreJournalRuntimeConfig,
  adapters: readonly ReconcileAdapter[],
): Promise<void> {
  const existingControl = await store.getTenantRestoreJournalControl();
  validateTenantRestoreJournalControlRecord(existingControl);
  if (existingControl.controlGeneration === 1) {
    const runtime = await store.getTenantRestoreRuntimeControl();
    const targets = await store.getTenantRestoreJournalControlTargets();
    const durableHeads = await store.getTenantRestoreRuntimeHeads();
    const externalHeads = await readExternalHeads(config, adapters, false);
    validateTenantRestoreRuntimeControlRecord(runtime);
    const configuredTargets = descriptorCatalog(config);
    if (!controlMatchesConfig(existingControl, config)
      || !runtimeMatchesConfig(runtime, existingControl, config)
      || runtime.lineageKind !== "primary"
      || targets.length !== configuredTargets.length
      || targets.some((target, index) => !sameDescriptor(target, configuredTargets[index]!))) {
      throw cliError("invalid_durable_state");
    }
    if (!sameSealedTargets(durableHeads, externalHeads)) {
      throw cliError("runtime_head_changed_forward_fix_required");
    }
    return;
  }
  const observedHeads = await readExternalHeads(config, adapters, false);
  if (observedHeads.some((head) => (
    head.sealedRemoteSequence !== 0
    || head.sealedHeadRootSha256 !== EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256
  ))) throw cliError("journal_not_empty");
  const input = {
    adapterProtocol: config.adapterProtocol,
    journalNamespaceSha256: config.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: config.logicalDatabaseNamespaceSha256,
    runtimeEpochSha256: config.runtimeEpochSha256,
    targets: descriptorCatalog(config),
    observedHeads,
  };
  try {
    await store.activateTenantRestoreJournalControl(input);
  } catch {
    // A response can be lost after the atomic cutover. Only a complete durable reconstruction plus
    // a fresh post-commit external read is accepted as success below.
  }
  await assertPrimaryActivationCommitted(store, config, adapters, observedHeads);
}

async function abortRestore(
  store: ReconcileStore,
  env: NodeJS.ProcessEnv,
): Promise<TenantRestoreReplayRunRecord> {
  const settings = RestoreRunEnv.parse(env);
  let changed = false;
  try {
    changed = await store.abortTenantRestoreReplay(settings.RESTORE_RUN_ID);
  } catch (error) {
    const run = await store.getTenantRestoreReplayRun(settings.RESTORE_RUN_ID).catch(() => null);
    if (!run || run.phase !== "aborted") throw error;
    validateTenantRestoreReplayRunRecord(run);
    if (run.restoreRunId !== settings.RESTORE_RUN_ID) throw error;
    return run;
  }
  const run = await store.getTenantRestoreReplayRun(settings.RESTORE_RUN_ID);
  if (!run || (!changed && run.phase !== "aborted") || run.phase !== "aborted") {
    throw cliError("invalid_durable_state");
  }
  validateTenantRestoreReplayRunRecord(run);
  return run;
}

function statusSummary(
  command: RestoreLedgerCommand,
  control: TenantRestoreJournalControlRecord,
  runtime: TenantRestoreRuntimeControlRecord,
  run: TenantRestoreReplayRunRecord | null,
): string {
  validateTenantRestoreJournalControlRecord(control);
  validateTenantRestoreRuntimeControlRecord(runtime);
  if (run) validateTenantRestoreReplayRunRecord(run);
  return JSON.stringify({
    status: "ok",
    command,
    journalControlGeneration: control.controlGeneration,
    runtimeState: runtime.state,
    runtimeControlGeneration: runtime.controlGeneration,
    runtimeUpdateKind: runtime.state === "active" ? runtime.updateKind : null,
    restorePhase: run?.phase ?? null,
    targetCount: run?.targetCount
      ?? (control.controlGeneration === 1 ? control.targetCount : 0),
    expectedEntryCount: run?.expectedEntryCount ?? 0,
    entryCount: run?.entryCount ?? 0,
    fenceCount: run?.fenceCount ?? 0,
  });
}

function loadRuntimeConfig(
  env: NodeJS.ProcessEnv,
  dependencies: RestoreLedgerReconcileCliDependencies,
): TenantRestoreJournalRuntimeConfig {
  const blobS3Bucket = env.BLOB_STORE === "s3" ? env.BLOB_S3_BUCKET : undefined;
  const config = dependencies.loadJournalConfig(env, {
    production: env.NODE_ENV === "production",
    store: "mysql",
    ...(blobS3Bucket === undefined ? {} : { blobS3Bucket }),
  });
  if (!config) throw cliError("invalid_configuration");
  return config;
}

function closeSafely(resource: { close(): Promise<void> } | undefined): Promise<void> | undefined {
  return resource === undefined
    ? undefined
    : Promise.resolve().then(() => resource.close());
}

export async function runRestoreLedgerReconcileCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RestoreLedgerReconcileCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const command = parseCommand(argv);
  const mysql = MysqlEnv.parse(env);
  const restoreRunId = env.RESTORE_RUN_ID;
  if (restoreRunId !== undefined && !RESTORE_RUN_ID.test(restoreRunId)) {
    throw cliError("invalid_configuration");
  }

  // Status intentionally avoids constructing an object-store client. Every mutating command first
  // parses its complete local configuration before it can acquire a DB connection. Abort and seal
  // verification are DB-only recovery boundaries and remain available during an object-store outage.
  const adapterCommand = command === "activate-journal"
    || command === "prepare"
    || command === "replay-fences"
    || command === "activate-runtime"
    || command === "run";
  // Parse all command-specific authority before creating credential-bearing clients or connecting
  // to the database. Invalid invocations therefore have no external resource lifecycle to unwind.
  if (command === "activate-journal") PrimaryActivationEnv.parse(env);
  else if (command !== "status") RestoreRunEnv.parse(env);
  if (command === "prepare" || command === "run") PrepareEnv.parse(env);
  if (command === "replay-fences" || command === "run") parsePageSize(env);
  const config = adapterCommand ? loadRuntimeConfig(env, dependencies) : undefined;
  const adapters = config === undefined
    ? []
    : Object.freeze([...dependencies.createAdapters(config)]);

  let store: ReconcileStore | undefined;
  let operationError: unknown;
  let summary: string | undefined;
  try {
    for (const adapter of adapters) await adapter.validateStartup();
    store = await dependencies.connectStore({
      url: mysql.MYSQL_URL,
      connectionLimit: command === "status" ? 1 : 2,
      migrationMode: "verify",
    });

    let run: TenantRestoreReplayRunRecord | null = restoreRunId === undefined
      ? null
      : await store.getTenantRestoreReplayRun(restoreRunId);
    if (command === "activate-journal") {
      await activatePrimaryJournal(store, config!, adapters);
    } else if (command === "prepare") {
      run = await prepareRestore(store, config!, adapters, env);
    } else if (command === "replay-fences") {
      run = await replayFences(store, config!, adapters, env);
    } else if (command === "verify") {
      run = await verifyRestore(store, env);
    } else if (command === "activate-runtime") {
      run = await activateRuntime(store, config!, adapters, env);
    } else if (command === "abort") {
      run = await abortRestore(store, env);
    } else if (command === "run") {
      const prepared = await prepareRestore(store, config!, adapters, env);
      if (prepared.phase === "prepared") {
        await replayFences(store, config!, adapters, env);
      } else if (prepared.phase !== "replay_sealed" && prepared.phase !== "active") {
        throw cliError("invalid_durable_state");
      }
      run = await verifyRestore(store, env);
    }

    const control = await store.getTenantRestoreJournalControl();
    const runtime = await store.getTenantRestoreRuntimeControl();
    if (restoreRunId !== undefined) run = await store.getTenantRestoreReplayRun(restoreRunId);
    summary = statusSummary(command, control, runtime, run);
  } catch (error) {
    operationError = error;
  }

  const closeResults = await Promise.allSettled([
    closeSafely(store),
    ...adapters.map((adapter) => closeSafely(adapter)),
  ].filter((operation): operation is Promise<void> => operation !== undefined));
  if (operationError !== undefined) throw operationError;
  if (closeResults.some((result) => result.status === "rejected") || summary === undefined) {
    throw cliError("operation_failed");
  }
  dependencies.writeLine(summary);
  return 0;
}

function errorCode(error: unknown): RestoreLedgerCliErrorCode {
  if (error instanceof RestoreLedgerCliError) return error.code;
  if (error instanceof z.ZodError) return "invalid_configuration";
  if (error instanceof TenantRestoreJournalConflictError) return "journal_conflict";
  if (error instanceof TenantRestoreJournalCorruptError) return "journal_corrupt";
  return "operation_failed";
}

/** Fixed, content-free output. In particular, never stringify dependency errors or environment. */
export function formatRestoreLedgerReconcileCliError(error: unknown): string {
  return JSON.stringify({ status: "error", code: errorCode(error) });
}
