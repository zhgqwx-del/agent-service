import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MemorySessionStore,
  MemoryTenantBackupCatalogAdapter,
  MemoryTenantRestoreJournalAdapter,
  tenantRestoreJournalTargetRootSha256,
  tenantRestoreLogicalDatabaseNamespaceSha256,
  tenantRestoreRuntimeEpochSha256,
  type TenantBackupCatalogAdapter,
  type TenantRestoreJournalAdapter,
  type TenantRestoreJournalTargetDescriptor,
} from "@agent-service/store";
import {
  formatBackupCatalogCliError,
  runBackupCatalogCli,
  type BackupCatalogCliDependencies,
} from "../src/backup-catalog-cli.js";
import type { TenantBackupCatalogRuntimeConfig } from
  "../src/tenant-backup-catalog-config.js";
import type { TenantRestoreJournalRuntimeConfig } from
  "../src/tenant-restore-journal-config.js";
import { MySqlBackupArtifactError } from "../src/mysql-backup-artifact.js";

const MYSQL_URL = "mysql://fixture@127.0.0.1:3306/agent_service_test";
const PRIMARY_EPOCH_ID = "backup-cli-primary-epoch-v1";
const RESTORE_EPOCH_ID = "backup-cli-restore-epoch-v2";
const BACKUP_ID_1 = "backup_00000000-0000-4000-8000-000000000001";
const BACKUP_ID_2 = "backup_00000000-0000-4000-8000-000000000002";
const BACKUP_ID_3 = "backup_00000000-0000-4000-8000-000000000003";
const RESTORE_RUN_ID = "restore_00000000-0000-4000-8000-000000000001";
const EVICTION_ID = "backup_evict_00000000-0000-4000-8000-000000000001";
const RESPONSE_LOSS_MARKER = "private-response-loss-marker";
const LOGICAL_DATABASE_NAMESPACE_SHA256 = tenantRestoreLogicalDatabaseNamespaceSha256(
  "backup-cli-database-v1",
);

function sha256(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

class TestClock {
  constructor(public value = 10_000) {}
  now(): number { return this.value; }
}

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { MYSQL_URL, ...extra };
}

function catalogEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return baseEnv({ BACKUP_CATALOG_ADAPTER: "s3", ...extra });
}

function activateEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return catalogEnv({
    BACKUP_CATALOG_ACTIVATION_ACK: "1",
    RESTORE_FLEET_STOPPED_ACK: "1",
    ...extra,
  });
}

function publishValues(label: string) {
  return {
    SOURCE_SNAPSHOT_SHA256: sha256(`${label}-source-snapshot`),
    SOURCE_BACKUP_SHA256: sha256(`${label}-source-backup`),
    BACKUP_ARTIFACT_MANIFEST_SHA256: sha256(`${label}-artifact-manifest`),
    BACKUP_PROVIDER_EVIDENCE_SHA256: sha256(`${label}-provider-evidence`),
  };
}

function publishEnv(
  backupId: string,
  label: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return catalogEnv({ BACKUP_ID: backupId, ...publishValues(label), ...extra });
}

function prepareRestoreEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return catalogEnv({
    BACKUP_ID: BACKUP_ID_1,
    RESTORE_RUN_ID,
    BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID,
    SOURCE_BACKUP_SHA256: publishValues("backup-one").SOURCE_BACKUP_SHA256,
    RESTORE_FLEET_STOPPED_ACK: "1",
    ...extra,
  });
}

function artifactEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return catalogEnv({
    BACKUP_ID: BACKUP_ID_1,
    BACKUP_ARTIFACT_LOCAL_ONLY_ACK: "1",
    BACKUP_ARTIFACT_DIRECTORY: "/private/fixture-artifacts",
    BACKUP_ARTIFACT_KEY_FILE: "/private/fixture-key",
    BACKUP_MYSQL_BINARY: "/private/trusted/mysql",
    BACKUP_MYSQLDUMP_BINARY: "/private/trusted/mysqldump",
    RESTORE_FLEET_STOPPED_ACK: "1",
    ...extra,
  });
}

/** Orchestration-only fake; real bytes/MySQL behavior is covered by the separate MySQL/S3 suite. */
function artifactHarness(state: Harness) {
  type Api = NonNullable<BackupCatalogCliDependencies["artifactOperations"]>;
  type Created = Awaited<ReturnType<Api["createMySqlBackupArtifact"]>>;
  const evidence: Created["evidence"] = {
    sourceSnapshotSha256: publishValues("actual-fixture").SOURCE_SNAPSHOT_SHA256,
    sourceBackupSha256: publishValues("actual-fixture").SOURCE_BACKUP_SHA256,
    artifactManifestSha256: publishValues("actual-fixture").BACKUP_ARTIFACT_MANIFEST_SHA256,
    providerEvidenceSha256: publishValues("actual-fixture").BACKUP_PROVIDER_EVIDENCE_SHA256,
  };
  const calls: string[] = [];
  const operator = Object.freeze({
    sourceIdentitySha256: sha256("actual-source-tuple"),
    targetIdentitySha256: sha256("actual-target-tuple"),
    assertHeld: vi.fn(async () => {}),
    close: vi.fn(async () => { calls.push("operator.close"); }),
    bindRestoreOperation: vi.fn(async () => { calls.push("operator.bind"); }),
    markRestorePrepared: vi.fn(async () => { calls.push("operator.prepared"); }),
  });
  const verifiedClose = vi.fn(async () => { calls.push("verified.close"); });
  const manifest = (anchor: Created["manifest"]["anchor"]) => ({
    version: 1, scope: "mysql-logical-full-artifact-v1",
    backupId: anchor.backupId, anchor, schemaMigrationRootSha256: anchor.schemaMigrationRootSha256,
  } as Created["manifest"]);
  const acquire = vi.fn(async () => { calls.push("operator.acquire"); return operator; });
  const create = vi.fn(async (input: Parameters<Api["createMySqlBackupArtifact"]>[0]): Promise<Created> => {
    calls.push("artifact.create");
    return { disposition: "created", manifest: manifest(input.anchor), evidence };
  });
  const verify = vi.fn(async (input: Parameters<Api["verifyMySqlBackupArtifact"]>[0]) => {
    calls.push("artifact.verify");
    const anchor = input.expectedAnchor!;
    return { manifest: manifest(anchor), evidence, close: verifiedClose };
  });
  const imported = vi.fn(async () => { calls.push("artifact.import"); });
  const operations = {
    acquireMySqlBackupArtifactOperator: acquire,
    createMySqlBackupArtifact: create,
    verifyMySqlBackupArtifact: verify,
    importVerifiedMySqlBackupArtifact: imported,
  } as unknown as Api;
  state.dependencies.artifactOperations = operations;
  return { evidence, calls, operator, verifiedClose, acquire, create, verify, imported };
}

interface HarnessOptions {
  minimumRetentionMs?: number;
  minimumRecoverableBackups?: number;
  loseFirstCatalogEventResponse?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const clock = new TestClock();
  const store = new MemorySessionStore(clock, {
    tenantBackupSchemaMigrationNames: ["0031-backup-cli-fixture"],
  });
  const storeClose = vi.spyOn(store, "close");
  let loseCatalogEventResponse = options.loseFirstCatalogEventResponse ?? false;
  const catalogDelegate = new MemoryTenantBackupCatalogAdapter({
    nonProductionFixture: true,
    namespaceId: "backup-cli-catalog-v1",
    targetId: "backup-cli-catalog-target-v1",
    failureDomainId: "backup-cli-independent-fixture-v1",
    afterEventCommit: () => {
      if (loseCatalogEventResponse) {
        loseCatalogEventResponse = false;
        throw new Error(RESPONSE_LOSS_MARKER);
      }
    },
  });
  const catalogAdapter: TenantBackupCatalogAdapter = {
    adapterProtocol: catalogDelegate.adapterProtocol,
    catalogNamespaceSha256: catalogDelegate.catalogNamespaceSha256,
    catalogTargetSha256: catalogDelegate.catalogTargetSha256,
    failureDomainSha256: catalogDelegate.failureDomainSha256,
    validateStartup: vi.fn(() => catalogDelegate.validateStartup()),
    publishAvailability: (input) => catalogDelegate.publishAvailability(input),
    inspectAvailability: (backupId) => catalogDelegate.inspectAvailability(backupId),
    reserveRestore: (input) => catalogDelegate.reserveRestore(input),
    resolveRestore: (input) => catalogDelegate.resolveRestore(input),
    recordEviction: (input) => catalogDelegate.recordEviction(input),
    readHead: () => catalogDelegate.readHead(),
    scanEvents: (input) => catalogDelegate.scanEvents(input),
    // Each CLI invocation releases its client; the delegate models the persistent remote target.
    close: vi.fn(async () => {}),
  };
  const catalogConfig = {
    adapterProtocol: catalogAdapter.adapterProtocol,
    catalogNamespaceSha256: catalogAdapter.catalogNamespaceSha256,
    catalogTargetSha256: catalogAdapter.catalogTargetSha256,
    failureDomainSha256: catalogAdapter.failureDomainSha256,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    retentionPolicySha256: sha256("backup-cli-retention-policy"),
    minimumRetentionMs: options.minimumRetentionMs ?? 100,
    minimumRecoverableBackups: options.minimumRecoverableBackups ?? 1,
    options: {},
  } as unknown as TenantBackupCatalogRuntimeConfig;

  const journalDelegate = new MemoryTenantRestoreJournalAdapter({
    nonProductionFixture: true,
    namespaceId: "backup-cli-journal-v1",
    failureDomainId: "backup-cli-journal-independent-fixture-v1",
    targetId: "backup-cli-journal-target-v1",
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
  });
  const journalAdapter: TenantRestoreJournalAdapter & {
    validateStartup(): Promise<void>;
  } = {
    adapterProtocol: journalDelegate.adapterProtocol,
    journalNamespaceSha256: journalDelegate.journalNamespaceSha256,
    targetSha256: journalDelegate.targetSha256,
    failureDomainSha256: journalDelegate.failureDomainSha256,
    logicalDatabaseNamespaceSha256: journalDelegate.logicalDatabaseNamespaceSha256,
    validateStartup: vi.fn(async () => {}),
    publishRecord: (record) => journalDelegate.publishRecord(record),
    inspectRecord: (record) => journalDelegate.inspectRecord(record),
    readHead: () => journalDelegate.readHead(),
    scanRecords: (input) => journalDelegate.scanRecords(input),
    close: vi.fn(async () => {}),
  };
  const descriptor: TenantRestoreJournalTargetDescriptor = {
    targetOrdinal: 0,
    targetSha256: journalAdapter.targetSha256,
    failureDomainSha256: journalAdapter.failureDomainSha256,
    adapterProtocol: journalAdapter.adapterProtocol,
    journalNamespaceSha256: journalAdapter.journalNamespaceSha256,
  };
  const journalConfig = (epochId: string): TenantRestoreJournalRuntimeConfig => ({
    adapterProtocol: journalAdapter.adapterProtocol,
    journalNamespaceSha256: journalAdapter.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    runtimeEpochSha256: tenantRestoreRuntimeEpochSha256(epochId),
    targetRootSha256: tenantRestoreJournalTargetRootSha256([descriptor]),
    targets: [{ descriptor, options: {} }],
  } as unknown as TenantRestoreJournalRuntimeConfig);

  const output: string[] = [];
  const connectStore = vi.fn(async (_options: Parameters<BackupCatalogCliDependencies["connectStore"]>[0]) => store);
  const loadCatalogConfig = vi.fn(() => catalogConfig);
  const createCatalogAdapter = vi.fn(() => catalogAdapter);
  const loadJournalConfig = vi.fn((env: NodeJS.ProcessEnv) => journalConfig(
    env.RESTORE_JOURNAL_RUNTIME_EPOCH_ID ?? PRIMARY_EPOCH_ID,
  ));
  const createJournalAdapters = vi.fn(() => [journalAdapter]);
  const dependencies: BackupCatalogCliDependencies = {
    connectStore: connectStore as BackupCatalogCliDependencies["connectStore"],
    loadCatalogConfig,
    createCatalogAdapter:
      createCatalogAdapter as BackupCatalogCliDependencies["createCatalogAdapter"],
    loadJournalConfig,
    createJournalAdapters:
      createJournalAdapters as BackupCatalogCliDependencies["createJournalAdapters"],
    writeLine: (line) => output.push(line),
  };
  return {
    clock,
    store,
    storeClose,
    catalogDelegate,
    catalogAdapter,
    catalogConfig,
    journalDelegate,
    journalAdapter,
    descriptor,
    output,
    connectStore,
    loadCatalogConfig,
    createCatalogAdapter,
    loadJournalConfig,
    createJournalAdapters,
    dependencies,
  };
}

type Harness = ReturnType<typeof createHarness>;

async function initializePrimary(state: Harness): Promise<void> {
  const head = await state.journalDelegate.readHead();
  await state.store.activateTenantRestoreJournalControl({
    adapterProtocol: state.journalAdapter.adapterProtocol,
    journalNamespaceSha256: state.journalAdapter.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    runtimeEpochSha256: tenantRestoreRuntimeEpochSha256(PRIMARY_EPOCH_ID),
    targets: [state.descriptor],
    observedHeads: [{
      ...state.descriptor,
      logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
      sealedRemoteSequence: head.remoteSequence,
      sealedHeadRootSha256: head.headRootSha256,
    }],
  });
  await state.store.activateBlobStorageControl({
    expectedControlGeneration: 0,
    storageBackend: "memory-v1",
    namespaceSha256: sha256("backup-cli-blob-namespace"),
  });
}

async function activateCatalog(state: Harness): Promise<void> {
  await initializePrimary(state);
  await runBackupCatalogCli(["activate"], activateEnv(), state.dependencies);
}

async function createAndPublish(
  state: Harness,
  backupId: string,
  label: string,
): Promise<void> {
  await runBackupCatalogCli(
    ["begin-backup"],
    catalogEnv({ BACKUP_ID: backupId, RESTORE_FLEET_STOPPED_ACK: "1" }),
    state.dependencies,
  );
  await runBackupCatalogCli(["publish-backup"], publishEnv(backupId, label), state.dependencies);
}

async function externalAvailability(
  state: Harness,
  backupId: string,
  label: string,
  anchorSha256?: string,
) {
  const control = await state.store.getTenantBackupCatalogControl();
  const anchor = await state.store.getTenantBackupSnapshotAnchor(backupId);
  const registeredAtDbMs = anchor?.createdAtDbMs ?? state.clock.value;
  return {
    backupId,
    anchorSha256: anchor?.anchorSha256 ?? anchorSha256 ?? sha256(`${label}-anchor`),
    sourceSnapshotSha256: publishValues(label).SOURCE_SNAPSHOT_SHA256,
    sourceBackupSha256: publishValues(label).SOURCE_BACKUP_SHA256,
    artifactManifestSha256: publishValues(label).BACKUP_ARTIFACT_MANIFEST_SHA256,
    providerEvidenceSha256: publishValues(label).BACKUP_PROVIDER_EVIDENCE_SHA256,
    controlEvidenceSha256: control.state === "active"
      ? control.evidenceSha256
      : sha256("inactive-external-control"),
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    retentionPolicySha256: state.catalogConfig.retentionPolicySha256!,
    retentionUntilDbMs: anchor?.retentionUntilDbMs
      ?? registeredAtDbMs + state.catalogConfig.minimumRetentionMs!,
    registeredAtDbMs,
  };
}

describe("backup catalog artifact CLI orchestration", () => {
  it("passes one protected exact key to source and restored target, then zeroes only the operator buffer", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    const keys: Buffer[] = [];
    const storeCopies: Buffer[] = [];
    state.dependencies.readRefKey = async () => { const key = Buffer.alloc(32, 0x51); keys.push(key); return key; };
    state.connectStore.mockImplementation(async (options) => {
      expect(options.migrationMode).toBe("verify");
      expect(options.tenantTelemetryRefKey instanceof Uint8Array).toBe(true);
      const bytes = options.tenantTelemetryRefKey!;
      expect(bytes.length).toBe(32);
      expect(bytes.every((byte) => byte === 0x51), "exact protected bytes must reach each store").toBe(true);
      storeCopies.push(Buffer.from(bytes));
      return state.store;
    });
    const env = { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/protected-ref-key" };
    await runBackupCatalogCli(["create-artifact"], artifactEnv(env), state.dependencies);
    state.connectStore.mockClear();
    await runBackupCatalogCli(["restore-selected"], artifactEnv({ ...env,
      RESTORE_RUN_ID, BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID,
      BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/keyed_target",
    }), state.dependencies);
    expect(state.connectStore).toHaveBeenCalledTimes(2);
    expect(artifacts.imported).toHaveBeenCalledOnce();
    expect(keys.every((key) => key.every((byte) => byte === 0)), "operator buffers are zeroed after closure").toBe(true);
    expect(storeCopies.every((key) => key.every((byte) => byte === 0x51)), "store-owned copies are not prematurely zeroed").toBe(true);
    storeCopies.forEach((key) => key.fill(0));
    expect(state.output.join("\n")).not.toContain("protected-ref-key");
  });

  it("bounds protected key acquisition with the artifact operation budget and zeroes a late reader result", async () => {
    const state = createHarness();
    const key = Buffer.alloc(32, 0x53);
    state.dependencies.readRefKey = () => new Promise((resolve) => { setTimeout(() => resolve(key), 30); });
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv({
      TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/bounded-ref-key", BACKUP_ARTIFACT_DEADLINE_MS: "10",
    }), state.dependencies)).rejects.toThrow("operation_deadline");
    expect(key.every((byte) => byte === 0), "late protected key must be zeroed").toBe(true);
    expect(state.connectStore).not.toHaveBeenCalled();
    expect(state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(state.output).toEqual([]);
  });

  it("formats only a known deadline code and never exposes arbitrary core error text", () => {
    expect(formatBackupCatalogCliError(new MySqlBackupArtifactError("operation_deadline")))
      .toBe('{"status":"error","code":"operation_deadline"}');
    expect(formatBackupCatalogCliError(new MySqlBackupArtifactError("private-key-DSN-marker")))
      .toBe('{"status":"error","code":"operation_failed"}');
  });
  it.each([
    { NODE_ENV: "production" }, { BACKUP_ARTIFACT_LOCAL_ONLY_ACK: "0" },
    { BACKUP_ARTIFACT_KEY_FILE: "relative-key" }, { BACKUP_ARTIFACT_DEADLINE_MS: "600001" },
    { BACKUP_ARTIFACT_MAX_BYTES: "1073741825" }, { BACKUP_MYSQL_BINARY: "mysql" },
    { RESTORE_FLEET_STOPPED_ACK: "0" },
  ])("rejects local authority before connecting or acquiring an operator: %j", async (extra) => {
    const state = createHarness();
    const artifacts = artifactHarness(state);
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv(extra), state.dependencies)).rejects.toThrow();
    expect(state.connectStore).not.toHaveBeenCalled();
    expect(state.loadCatalogConfig).not.toHaveBeenCalled();
    expect(artifacts.acquire).not.toHaveBeenCalled();
  });

  it("holds the operator from anchor through bytes authentication and publication", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    const anchor = vi.spyOn(state.store, "createTenantBackupSnapshotAnchor");
    const publish = vi.spyOn(state.catalogAdapter, "publishAvailability");
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    expect(artifacts.acquire.mock.invocationCallOrder[0]).toBeLessThan(anchor.mock.invocationCallOrder[0]!);
    expect(anchor.mock.invocationCallOrder[0]).toBeLessThan(artifacts.create.mock.invocationCallOrder[0]!);
    expect(artifacts.verify.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0]!);
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(artifacts.operator.close.mock.invocationCallOrder[0]!);
    expect(publish.mock.calls[0]![0]).toMatchObject(artifacts.evidence);
    expect(artifacts.create.mock.calls[0]![0].captureCheckpointStore).toBe(state.store);
    expect(state.connectStore.mock.calls.at(-1)![0].tenantTelemetryCaptureRestoreLocalOnly).toBe(true);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({ command: "create-artifact", artifactVerified: true, ...artifacts.evidence });
    expect(state.output.join("\n")).not.toContain("/private/");
    expect(artifacts.verifiedClose).toHaveBeenCalledOnce();
  });

  it("rechecks a v2 source after bytes authentication and refuses external publication on drift", async () => {
    const state = createHarness(); await activateCatalog(state); const artifacts = artifactHarness(state);
    // Orchestration-only fixture: actual checkpoint/leaf authentication is covered
    // by the artifact pipeline and isolated MySQL tests, not this partial mock.
    const checkpointSha256 = sha256("actual-sealed-checkpoint");
    artifacts.verify.mockImplementationOnce(async (input) => ({
      manifest: { version: 2, anchor: input.expectedAnchor!, captureCheckpoint: { checkpointSha256 } } as never,
      evidence: artifacts.evidence, close: artifacts.verifiedClose,
    }));
    const unchanged = vi.spyOn(state.store, "assertTenantTelemetryCaptureBackupCheckpointUnchanged")
      .mockRejectedValueOnce(new Error("private-live-source-drift"));
    const publish = vi.spyOn(state.catalogAdapter, "publishAvailability");
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies)).rejects.toThrow();
    expect(unchanged).toHaveBeenCalledWith({ backupId: BACKUP_ID_1, checkpointSha256,
      fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" });
    expect(artifacts.verify.mock.invocationCallOrder[0]).toBeLessThan(unchanged.mock.invocationCallOrder[0]!);
    expect(publish).not.toHaveBeenCalled(); expect(artifacts.verifiedClose).toHaveBeenCalledOnce();
  });

  it.each([1, 2])("replays already-published v%s exact evidence despite current source/catalog head drift", async (version) => {
    const state = createHarness(); await activateCatalog(state); const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    const publishedBefore = await state.catalogAdapter.inspectAvailability(BACKUP_ID_1);
    const headBefore = await state.catalogAdapter.readHead();
    expect(headBefore.catalogSequence).toBeGreaterThan(0);
    const manifest = (anchor: Parameters<typeof artifacts.create>[0]["anchor"]) => ({ version, anchor,
      schemaMigrationRootSha256: anchor.schemaMigrationRootSha256,
      ...(version === 2 ? { captureCheckpoint: { checkpointSha256: sha256("historical-checkpoint") } } : {}),
    } as never);
    // The real producer independently authenticates actual historical SQL leaves;
    // these mocks isolate CLI's exact-replay publication ordering only.
    artifacts.create.mockImplementationOnce(async (input) => ({ disposition: "exact_replay", manifest: manifest(input.anchor), evidence: artifacts.evidence }));
    artifacts.verify.mockImplementationOnce(async (input) => ({ manifest: manifest(input.expectedAnchor!), evidence: artifacts.evidence, close: artifacts.verifiedClose }));
    const seal = vi.spyOn(state.store, "sealTenantTelemetryCaptureBackupCheckpoint").mockRejectedValue(new Error("current-head-advanced"));
    const unchanged = vi.spyOn(state.store, "assertTenantTelemetryCaptureBackupCheckpointUnchanged").mockRejectedValue(new Error("current-source-drift"));
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies)).resolves.toBe(0);
    expect(seal).not.toHaveBeenCalled(); expect(unchanged).not.toHaveBeenCalled();
    expect(await state.catalogAdapter.inspectAvailability(BACKUP_ID_1)).toEqual(publishedBefore);
    expect(await state.catalogAdapter.readHead()).toEqual(headBefore);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({ disposition: "exact_replay", artifactVerified: true, ...artifacts.evidence });
  });

  it("does not make historical verify-artifact depend on the current mutable source checkpoint", async () => {
    const state = createHarness(); await activateCatalog(state); const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    const seal = vi.spyOn(state.store, "sealTenantTelemetryCaptureBackupCheckpoint").mockRejectedValue(new Error("source-now-changed"));
    const unchanged = vi.spyOn(state.store, "assertTenantTelemetryCaptureBackupCheckpointUnchanged").mockRejectedValue(new Error("source-now-changed"));
    await expect(runBackupCatalogCli(["verify-artifact"], artifactEnv(), state.dependencies)).resolves.toBe(0);
    expect(seal).not.toHaveBeenCalled(); expect(unchanged).not.toHaveBeenCalled();
    expect(artifacts.imported).not.toHaveBeenCalled();
  });

  it("passes only the authenticated selected-v2 hash into preflight before external reservation and same target reprepare", async () => {
    const state = createHarness(); await activateCatalog(state); const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    const checkpointSha256 = sha256("selected-v2-checkpoint");
    artifacts.verify.mockImplementationOnce(async (input) => ({
      manifest: { version: 2, anchor: input.expectedAnchor!, schemaMigrationRootSha256: input.expectedAnchor!.schemaMigrationRootSha256,
        captureCheckpoint: { checkpointSha256 } } as never,
      evidence: artifacts.evidence, close: artifacts.verifiedClose,
    }));
    const preflightDelegate = state.store.preflightTenantRestoreReplayFromBackup.bind(state.store);
    const prepareDelegate = state.store.prepareTenantRestoreReplayFromBackup.bind(state.store);
    // Deliberately isolate field propagation from active-store authorization:
    // this fixture has inactive capture, so delegate the old inactive payload.
    const preflight = vi.spyOn(state.store, "preflightTenantRestoreReplayFromBackup").mockImplementation(async (input) => {
      expect(input.captureCheckpointSha256).toBe(checkpointSha256);
      const { captureCheckpointSha256: _hash, ...legacy } = input; return preflightDelegate(legacy);
    });
    const prepare = vi.spyOn(state.store, "prepareTenantRestoreReplayFromBackup").mockImplementation(async (input) => {
      expect(input.captureCheckpointSha256).toBe(checkpointSha256);
      const { captureCheckpointSha256: _hash, ...legacy } = input; return prepareDelegate(legacy);
    });
    const reserve = vi.spyOn(state.catalogAdapter, "reserveRestore");
    await runBackupCatalogCli(["restore-selected"], artifactEnv({ RESTORE_RUN_ID,
      BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID, BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/isolated_target" }), state.dependencies);
    expect(preflight).toHaveBeenCalledTimes(2); expect(prepare).toHaveBeenCalledTimes(2);
    expect(preflight.mock.invocationCallOrder[0]).toBeLessThan(reserve.mock.invocationCallOrder[0]!);
    expect(preflight.mock.invocationCallOrder[1]).toBeLessThan(reserve.mock.invocationCallOrder[1]!);
    expect(prepare.mock.invocationCallOrder[1]).toBeGreaterThan(artifacts.imported.mock.invocationCallOrder[0]!);
  });

  it("does not infer selected-v1 authority from an unrelated existing checkpoint before reserve/import", async () => {
    const state = createHarness(); await activateCatalog(state); const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    const historical = vi.spyOn(state.store, "getTenantTelemetryCaptureBackupCheckpoint").mockResolvedValue({
      checkpoint: { checkpointSha256: sha256("unselected-live-checkpoint") }, leaves: [],
    } as never);
    const preflight = vi.spyOn(state.store, "preflightTenantRestoreReplayFromBackup").mockImplementation(async (input) => {
      expect(input.captureCheckpointSha256).toBeUndefined(); throw new Error("active-source-requires-selected-v2-checkpoint");
    });
    const reserve = vi.spyOn(state.catalogAdapter, "reserveRestore");
    await expect(runBackupCatalogCli(["restore-selected"], artifactEnv({ RESTORE_RUN_ID,
      BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID, BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/isolated_target" }), state.dependencies)).rejects.toThrow();
    expect(preflight).toHaveBeenCalledOnce(); expect(historical).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled(); expect(artifacts.imported).not.toHaveBeenCalled();
  });

  it("closes a constructed catalog client when the later journal factory fails", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    state.createJournalAdapters.mockImplementationOnce(() => { throw new Error("private-factory-config"); });
    state.connectStore.mockClear();
    const outputCount = state.output.length;
    await expect(runBackupCatalogCli(["restore-selected"], artifactEnv({
      RESTORE_RUN_ID, BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID,
      BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/isolated_target",
    }), state.dependencies)).rejects.toThrow();
    expect(state.catalogAdapter.close).toHaveBeenCalledTimes(2);
    expect(state.connectStore).not.toHaveBeenCalled();
    expect(artifacts.acquire).not.toHaveBeenCalled();
    expect(state.output).toHaveLength(outputCount);
  });

  it("requires fresh availability before authenticating bytes", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    artifacts.verify.mockClear();
    state.catalogAdapter.inspectAvailability = vi.fn(async () => null);
    await expect(runBackupCatalogCli(["verify-artifact"], artifactEnv(), state.dependencies)).rejects.toThrow("catalog_conflict");
    expect(artifacts.verify).not.toHaveBeenCalled();
  });

  it("refuses an actual sealed eviction even though inspectAvailability retains its historical entry", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    await createAndPublish(state, BACKUP_ID_2, "second-backup");
    state.clock.value += 100;
    const eviction = catalogEnv({ BACKUP_ID: BACKUP_ID_1, BACKUP_EVICTION_ID: EVICTION_ID,
      RESTORE_FLEET_STOPPED_ACK: "1", BACKUP_PHYSICAL_ABSENCE_ACK: "1",
      EXTERNAL_TOMBSTONE_SHA256: sha256("physical-absence") });
    await runBackupCatalogCli(["prepare-eviction"], eviction, state.dependencies);
    await runBackupCatalogCli(["record-eviction"], eviction, state.dependencies);
    expect(await state.catalogAdapter.inspectAvailability(BACKUP_ID_1)).not.toBeNull();
    artifacts.verify.mockClear();
    await expect(runBackupCatalogCli(["verify-artifact"], artifactEnv(), state.dependencies)).rejects.toThrow("catalog_conflict");
    expect(artifacts.verify).not.toHaveBeenCalled();
  });

  it("does not publish after whole-operation deadline expires in the producer", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    let elapsed = 0;
    state.dependencies.now = () => elapsed;
    artifacts.create.mockImplementationOnce(async (input) => {
      elapsed = 11;
      return { disposition: "created", manifest: { anchor: input.anchor } as Awaited<ReturnType<NonNullable<BackupCatalogCliDependencies["artifactOperations"]>["createMySqlBackupArtifact"]>>["manifest"], evidence: artifacts.evidence };
    });
    const publish = vi.spyOn(state.catalogAdapter, "publishAvailability");
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv({ BACKUP_ARTIFACT_DEADLINE_MS: "10" }), state.dependencies)).rejects.toThrow("operation_deadline");
    expect(publish).not.toHaveBeenCalled();
    expect(artifacts.verify).not.toHaveBeenCalled();
    expect(artifacts.operator.close).toHaveBeenCalledOnce();
  });

  it("closes an operator acquired exactly as the deadline expires before connecting or writing an anchor", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    let elapsed = 0;
    state.dependencies.now = () => elapsed;
    state.connectStore.mockClear();
    artifacts.acquire.mockImplementationOnce(async () => { elapsed = 11; return artifacts.operator; });
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv({ BACKUP_ARTIFACT_DEADLINE_MS: "10" }), state.dependencies)).rejects.toThrow("operation_deadline");
    expect(artifacts.operator.close).toHaveBeenCalledOnce();
    expect(state.connectStore).not.toHaveBeenCalled();
    expect(artifacts.create).not.toHaveBeenCalled();
  });

  it("bounds an uncompleted adapter startup by actual wall time and starts no authority", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    state.connectStore.mockClear();
    state.catalogAdapter.validateStartup = vi.fn(() => new Promise<void>(() => {}));
    const started = performance.now();
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv({
      BACKUP_ARTIFACT_DEADLINE_MS: "1000",
    }), state.dependencies)).rejects.toThrow("operation_deadline");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(state.catalogAdapter.validateStartup).toHaveBeenCalledOnce();
    expect(artifacts.acquire).not.toHaveBeenCalled();
    expect(state.connectStore).not.toHaveBeenCalled();
  });

  it("disposes a late store without releasing the operator lock while work is pending", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    let resolveStore!: (value: typeof state.store) => void;
    state.connectStore.mockClear();
    state.connectStore.mockImplementationOnce(() => new Promise((resolve) => { resolveStore = resolve; }));
    const anchor = vi.spyOn(state.store, "createTenantBackupSnapshotAnchor");
    const started = performance.now();
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv({
      BACKUP_ARTIFACT_DEADLINE_MS: "1000",
    }), state.dependencies)).rejects.toThrow("operation_deadline");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(state.connectStore).toHaveBeenCalledOnce();
    expect(artifacts.operator.close).not.toHaveBeenCalled();
    expect(state.connectStore.mock.calls.at(-1)![0]).toMatchObject({ operationAbortSignal: expect.any(AbortSignal) });
    expect(state.connectStore.mock.calls.at(-1)![0].operationAbortSignal!.aborted).toBe(true);
    resolveStore(state.store);
    await vi.waitFor(() => expect(artifacts.operator.close).toHaveBeenCalledOnce());
    expect(anchor).not.toHaveBeenCalled();
    expect(artifacts.create).not.toHaveBeenCalled();
  });

  it("bounds a never-resolving reservation and never imports after its deadline", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    state.catalogAdapter.reserveRestore = vi.fn(() => new Promise<never>(() => {}));
    const started = performance.now();
    let failure: unknown;
    try {
      await runBackupCatalogCli(["restore-selected"], artifactEnv({
        RESTORE_RUN_ID, BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID,
        BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/isolated_target",
        BACKUP_ARTIFACT_DEADLINE_MS: "1000",
      }), state.dependencies);
    } catch (error) { failure = error; }
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(state.catalogAdapter.reserveRestore).toHaveBeenCalledOnce();
    expect(JSON.parse(formatBackupCatalogCliError(failure))).toMatchObject({
      code: "operation_deadline", reservationMayBeConsumed: true,
      targetMayContainPartialImport: false, requiresManualForwardFix: true,
    });
    expect(artifacts.imported).not.toHaveBeenCalled();
    expect(artifacts.operator.markRestorePrepared).not.toHaveBeenCalled();
    // Only create's prior operator has closed; pending custom work retains the restore lock.
    expect(artifacts.operator.close).toHaveBeenCalledTimes(1);
  });

  it.each(["readHead", "scanEvents", "mirror", "publishAvailability"] as const)(
    "bounds an uncompleted %s stage and never writes subsequent availability", async (stage) => {
      const state = createHarness();
      await activateCatalog(state);
      const artifacts = artifactHarness(state);
      await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
      const record = vi.spyOn(state.store, "recordTenantBackupCatalogAvailability");
      const hung = vi.fn(() => new Promise<never>(() => {}));
      if (stage === "readHead") state.catalogAdapter.readHead = hung;
      else if (stage === "scanEvents") state.catalogAdapter.scanEvents = hung;
      else if (stage === "mirror") vi.spyOn(state.store, "mirrorTenantBackupCatalogEvent")
        .mockImplementation(hung);
      else state.catalogAdapter.publishAvailability = hung;
      const outputCount = state.output.length;
      const started = performance.now();
      await expect(runBackupCatalogCli(["create-artifact"], artifactEnv({
        BACKUP_ID: BACKUP_ID_2, BACKUP_ARTIFACT_DEADLINE_MS: "1000",
      }), state.dependencies)).rejects.toThrow("operation_deadline");
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(hung).toHaveBeenCalledOnce();
      expect(state.output).toHaveLength(outputCount);
      expect(record).not.toHaveBeenCalled();
    },
  );

  it("does not report success or record a published availability after the source lock is lost", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    let lost = false;
    artifacts.operator.assertHeld.mockImplementation(async () => { if (lost) throw new Error("private-lock-loss"); });
    const publish = state.catalogAdapter.publishAvailability;
    state.catalogAdapter.publishAvailability = async (input) => {
      const result = await publish(input);
      lost = true;
      return result;
    };
    const record = vi.spyOn(state.store, "recordTenantBackupCatalogAvailability");
    const outputCount = state.output.length;
    await expect(runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies)).rejects.toThrow();
    expect(await state.catalogDelegate.inspectAvailability(BACKUP_ID_1)).not.toBeNull();
    expect(record).not.toHaveBeenCalled();
    expect(state.output).toHaveLength(outputCount);
  });

  it.each(["run", "epoch"] as const)("rejects a previous permanent %s reservation even with another directory and target", async (reuse) => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    expect(Object.isFrozen(artifacts.operator)).toBe(true);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    const entry = await state.catalogAdapter.inspectAvailability(BACKUP_ID_1);
    await state.catalogAdapter.reserveRestore({ backupId: BACKUP_ID_1, entrySha256: entry!.entrySha256,
      restoreRunId: RESTORE_RUN_ID, runtimeEpochSha256: tenantRestoreRuntimeEpochSha256(RESTORE_EPOCH_ID) });
    await expect(runBackupCatalogCli(["restore-selected"], artifactEnv({
      BACKUP_ARTIFACT_DIRECTORY: "/private/another-fixture-artifacts",
      RESTORE_RUN_ID: reuse === "run" ? RESTORE_RUN_ID : "restore_00000000-0000-4000-8000-000000000002",
      BACKUP_RUNTIME_EPOCH_ID: reuse === "epoch" ? RESTORE_EPOCH_ID : "different-never-used-epoch",
      BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/second_empty_target",
    }), state.dependencies)).rejects.toThrow("catalog_conflict");
    expect(artifacts.operator.assertHeld).toHaveBeenCalled();
    expect(artifacts.operator.bindRestoreOperation).not.toHaveBeenCalled();
    expect(artifacts.imported).not.toHaveBeenCalled();
  });

  it("reserves on source, imports held authentication and verifies the target before exact reprepare", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    const prepared = vi.spyOn(state.store, "prepareTenantRestoreReplayFromBackup");
    state.connectStore.mockClear();
    await runBackupCatalogCli(["restore-selected"], artifactEnv({
      RESTORE_RUN_ID, BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID,
      BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/isolated_target",
    }), state.dependencies);
    expect(prepared).toHaveBeenCalledTimes(2);
    expect(artifacts.operator.bindRestoreOperation.mock.invocationCallOrder[0]).toBeLessThan(prepared.mock.invocationCallOrder[0]!);
    expect(prepared.mock.invocationCallOrder[0]).toBeLessThan(artifacts.imported.mock.invocationCallOrder[0]!);
    expect(artifacts.imported.mock.invocationCallOrder[0]).toBeLessThan(state.connectStore.mock.invocationCallOrder[1]!);
    expect(state.connectStore.mock.calls[1]![0]).toMatchObject({ migrationMode: "verify", url: "mysql://fixture@127.0.0.1:3306/isolated_target" });
    expect(state.connectStore.mock.calls.map(([options]) => options.tenantTelemetryCaptureRestoreLocalOnly)).toEqual([true, true]);
    expect(prepared.mock.invocationCallOrder[1]).toBeLessThan(artifacts.operator.markRestorePrepared.mock.invocationCallOrder[0]!);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({ command: "restore-selected", restorePhase: "prepared", runtimeActivated: false, fenceReplayComplete: false });
  });

  it("preserves reservation and closes held resources when post-import target verification fails", async () => {
    const state = createHarness();
    await activateCatalog(state);
    const artifacts = artifactHarness(state);
    await runBackupCatalogCli(["create-artifact"], artifactEnv(), state.dependencies);
    state.connectStore.mockImplementation(async (input?: { url: string }) => {
      if (input?.url.includes("isolated_target")) throw new Error("private-target-DSN-and-key-marker");
      return state.store;
    });
    const outputCount = state.output.length;
    let failure: unknown;
    try {
      await runBackupCatalogCli(["restore-selected"], artifactEnv({
        RESTORE_RUN_ID, BACKUP_RUNTIME_EPOCH_ID: RESTORE_EPOCH_ID,
        BACKUP_RESTORE_TARGET_MYSQL_URL: "mysql://fixture@127.0.0.1:3306/isolated_target",
      }), state.dependencies);
    } catch (error) { failure = error; }
    expect(JSON.parse(formatBackupCatalogCliError(failure))).toEqual({
      status: "error", code: "operation_failed", reservationMayBeConsumed: true,
      targetMayContainPartialImport: true, requiresManualForwardFix: true, runtimeActivated: false,
    });
    expect(state.output).toHaveLength(outputCount);
    expect(artifacts.imported).toHaveBeenCalledOnce();
    expect(artifacts.operator.markRestorePrepared).not.toHaveBeenCalled();
    expect(await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID)).toMatchObject({ phase: "reserved" });
    expect(artifacts.operator.close).toHaveBeenCalledTimes(2);
    expect(artifacts.verifiedClose).toHaveBeenCalledTimes(2);
  });
});

describe("backup catalog CLI", () => {
  it("keeps inactive keyless status compatible and accepts a protected key without constructing S3", async () => {
    const state = createHarness();
    await runBackupCatalogCli(["status"], baseEnv(), state.dependencies);
    expect(state.connectStore.mock.calls.at(-1)![0].tenantTelemetryRefKey).toBeUndefined();
    expect(state.connectStore.mock.calls.at(-1)![0].tenantTelemetryCaptureRestoreLocalOnly).toBeUndefined();
    const key = Buffer.alloc(32, 0x29);
    state.dependencies.readRefKey = async () => key;
    state.connectStore.mockImplementation(async (input) => {
      expect(input.tenantTelemetryRefKey instanceof Uint8Array).toBe(true);
      expect(input.tenantTelemetryRefKey!.every((byte) => byte === 0x29), "exact key required").toBe(true);
      return state.store;
    });
    await runBackupCatalogCli(["status"], baseEnv({ TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/ref-key" }), state.dependencies);
    expect(key.every((byte) => byte === 0), "operator buffer must be zeroed").toBe(true);
    expect(state.createCatalogAdapter).not.toHaveBeenCalled();
  });

  it.each([{ TENANT_TELEMETRY_REF_KEY: "" }, { TENANT_TELEMETRY_REF_KEY: "private-key" },
    { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "" }, { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "relative" }])(
    "rejects ambient hex and invalid operator key authority before external resources %#", async (extra) => {
      const state = createHarness();
      const failure = await runBackupCatalogCli(["status"], baseEnv(extra), state.dependencies).catch((error: unknown) => error);
      expect(formatBackupCatalogCliError(failure)).toBe('{"status":"error","code":"invalid_configuration"}');
      expect(state.connectStore).not.toHaveBeenCalled();
      expect(state.createCatalogAdapter).not.toHaveBeenCalled();
    });

  it("zeros the protected buffer when strict startup rejects and never emits success", async () => {
    const state = createHarness();
    const key = Buffer.alloc(32, 0x37);
    state.dependencies.readRefKey = async () => key;
    state.connectStore.mockImplementation(async () => { throw new Error("private-audit-details"); });
    const failure = await runBackupCatalogCli(["status"], baseEnv({ TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/ref-key" }), state.dependencies)
      .catch((error: unknown) => error);
    expect(formatBackupCatalogCliError(failure)).toBe('{"status":"error","code":"operation_failed"}');
    expect(key.every((byte) => byte === 0), "rejected startup must zero the operator buffer").toBe(true);
    expect(state.output).toEqual([]);
  });

  it("rejects invalid authority before loading config, constructing clients, or connecting", async () => {
    const state = createHarness();
    const privateMarker = "private-invalid-authority-marker";
    let failure: unknown;
    try {
      await runBackupCatalogCli(["activate"], activateEnv({
        BACKUP_CATALOG_ACTIVATION_ACK: privateMarker,
      }), state.dependencies);
    } catch (error) {
      failure = error;
    }
    expect(state.loadCatalogConfig).not.toHaveBeenCalled();
    expect(state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(state.createJournalAdapters).not.toHaveBeenCalled();
    expect(state.connectStore).not.toHaveBeenCalled();
    expect(formatBackupCatalogCliError(failure))
      .toBe('{"status":"error","code":"invalid_configuration"}');
    expect(formatBackupCatalogCliError(failure)).not.toContain(privateMarker);
  });

  it("requires a stopped-fleet acknowledgement before either physical eviction command", async () => {
    for (const command of ["prepare-eviction", "record-eviction"] as const) {
      const state = createHarness();
      let failure: unknown;
      try {
        await runBackupCatalogCli([command], catalogEnv({
          BACKUP_ID: BACKUP_ID_1,
          BACKUP_EVICTION_ID: EVICTION_ID,
          ...(command === "record-eviction" ? {
            BACKUP_PHYSICAL_ABSENCE_ACK: "1",
            EXTERNAL_TOMBSTONE_SHA256: sha256("eviction-authority-tombstone"),
          } : {}),
        }), state.dependencies);
      } catch (error) {
        failure = error;
      }
      expect(formatBackupCatalogCliError(failure))
        .toBe('{"status":"error","code":"invalid_configuration"}');
      expect(state.loadCatalogConfig).not.toHaveBeenCalled();
      expect(state.createCatalogAdapter).not.toHaveBeenCalled();
      expect(state.connectStore).not.toHaveBeenCalled();
    }
  });

  it("requires a stopped-fleet acknowledgement before beginning a backup anchor", async () => {
    const state = createHarness();
    let failure: unknown;
    try {
      await runBackupCatalogCli(
        ["begin-backup"],
        catalogEnv({ BACKUP_ID: BACKUP_ID_1 }),
        state.dependencies,
      );
    } catch (error) {
      failure = error;
    }
    expect(formatBackupCatalogCliError(failure))
      .toBe('{"status":"error","code":"invalid_configuration"}');
    expect(state.loadCatalogConfig).not.toHaveBeenCalled();
    expect(state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(state.connectStore).not.toHaveBeenCalled();
  });

  it("keeps dormant status and list database-only", async () => {
    const state = createHarness();
    await runBackupCatalogCli(["status"], baseEnv(), state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      status: "ok",
      command: "status",
      catalogState: "inactive",
      catalogControlGeneration: 0,
      recoverableBackupCount: 0,
      externalCatalogSequence: null,
    });
    await runBackupCatalogCli(["list"], baseEnv(), state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toEqual({
      status: "ok",
      command: "list",
      count: 0,
      nextAfterBackupId: null,
      backups: [],
    });
    expect(state.loadCatalogConfig).not.toHaveBeenCalled();
    expect(state.createCatalogAdapter).not.toHaveBeenCalled();
    expect(state.createJournalAdapters).not.toHaveBeenCalled();
    expect(state.connectStore).toHaveBeenNthCalledWith(1, {
      url: MYSQL_URL,
      connectionLimit: 1,
      migrationMode: "verify",
    });
    expect(state.connectStore).toHaveBeenNthCalledWith(2, {
      url: MYSQL_URL,
      connectionLimit: 1,
      migrationMode: "verify",
    });
  });

  it("requires an empty external head and active journal/runtime/blob prerequisites", async () => {
    const nonEmpty = createHarness();
    await initializePrimary(nonEmpty);
    await nonEmpty.catalogDelegate.publishAvailability(await externalAvailability(
      nonEmpty,
      BACKUP_ID_3,
      "external-only",
      sha256("external-only-anchor"),
    ));
    await expect(runBackupCatalogCli(
      ["activate"],
      activateEnv(),
      nonEmpty.dependencies,
    )).rejects.toMatchObject({ code: "catalog_conflict" });
    expect(await nonEmpty.store.getTenantBackupCatalogControl()).toEqual({
      singletonId: 1,
      state: "inactive",
      controlGeneration: 0,
    });

    const inactive = createHarness();
    await expect(runBackupCatalogCli(
      ["activate"],
      activateEnv(),
      inactive.dependencies,
    )).rejects.toMatchObject({ code: "catalog_not_ready" });
    expect(await inactive.store.getTenantBackupCatalogControl()).toEqual({
      singletonId: 1,
      state: "inactive",
      controlGeneration: 0,
    });
  });

  it("replays begin and publish exactly after a committed external response is lost", async () => {
    const state = createHarness({ loseFirstCatalogEventResponse: true });
    await activateCatalog(state);
    await runBackupCatalogCli(
      ["begin-backup"],
      catalogEnv({ BACKUP_ID: BACKUP_ID_1, RESTORE_FLEET_STOPPED_ACK: "1" }),
      state.dependencies,
    );
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "begin-backup",
      disposition: "created",
      backupId: BACKUP_ID_1,
    });
    await runBackupCatalogCli(
      ["begin-backup"],
      catalogEnv({ BACKUP_ID: BACKUP_ID_1, RESTORE_FLEET_STOPPED_ACK: "1" }),
      state.dependencies,
    );
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "begin-backup",
      disposition: "exact_replay",
    });

    let failure: unknown;
    try {
      await runBackupCatalogCli(
        ["publish-backup"],
        publishEnv(BACKUP_ID_1, "backup-one"),
        state.dependencies,
      );
    } catch (error) {
      failure = error;
    }
    expect(formatBackupCatalogCliError(failure))
      .toBe('{"status":"error","code":"operation_failed"}');
    expect(formatBackupCatalogCliError(failure)).not.toContain(RESPONSE_LOSS_MARKER);
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_1)).toBeNull();
    expect(await state.catalogDelegate.inspectAvailability(BACKUP_ID_1)).not.toBeNull();

    await runBackupCatalogCli(
      ["publish-backup"],
      publishEnv(BACKUP_ID_1, "backup-one"),
      state.dependencies,
    );
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "publish-backup",
      disposition: "created",
      backupId: BACKUP_ID_1,
    });
    await runBackupCatalogCli(
      ["publish-backup"],
      publishEnv(BACKUP_ID_1, "backup-one"),
      state.dependencies,
    );
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "publish-backup",
      disposition: "exact_replay",
    });

    const configLoadsBeforeList = state.loadCatalogConfig.mock.calls.length;
    await runBackupCatalogCli(["list"], baseEnv(), state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "list",
      count: 1,
      backups: [{
        backupId: BACKUP_ID_1,
        sourceBackupSha256: publishValues("backup-one").SOURCE_BACKUP_SHA256,
      }],
    });
    expect(state.loadCatalogConfig).toHaveBeenCalledTimes(configLoadsBeforeList);
  });

  it("fully reconciles the external chain before creating a snapshot anchor", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await state.catalogDelegate.publishAvailability(await externalAvailability(
      state,
      BACKUP_ID_3,
      "external-before-anchor",
      sha256("missing-external-anchor"),
    ));
    const mirror = vi.spyOn(state.store, "mirrorTenantBackupCatalogEvent");

    await runBackupCatalogCli(
      ["begin-backup"],
      catalogEnv({
        BACKUP_ID: BACKUP_ID_1,
        RESTORE_FLEET_STOPPED_ACK: "1",
      }),
      state.dependencies,
    );

    const anchor = await state.store.getTenantBackupSnapshotAnchor(BACKUP_ID_1);
    const externalHead = await state.catalogDelegate.readHead();
    expect(anchor).toMatchObject({
      sourceCatalogSequence: externalHead.catalogSequence,
      sourceCatalogEventRootSha256: externalHead.catalogEventRootSha256,
    });
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_3)).not.toBeNull();
    expect(mirror).toHaveBeenCalledOnce();
  });

  it("fails closed when the recorded availability is not the exact published result", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await runBackupCatalogCli(
      ["begin-backup"],
      catalogEnv({
        BACKUP_ID: BACKUP_ID_1,
        RESTORE_FLEET_STOPPED_ACK: "1",
      }),
      state.dependencies,
    );
    const record = state.store.recordTenantBackupCatalogAvailability.bind(state.store);
    state.store.recordTenantBackupCatalogAvailability = async (input) => {
      const result = await record(input);
      return {
        ...result,
        value: {
          ...result.value,
          controlEvidenceSha256: sha256("tampered-control-evidence"),
        },
      };
    };

    await expect(runBackupCatalogCli(
      ["publish-backup"],
      publishEnv(BACKUP_ID_1, "backup-one"),
      state.dependencies,
    )).rejects.toMatchObject({ code: "invalid_durable_state" });
  });

  it("reconciles the sealed external prefix before reserving a restore epoch", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await createAndPublish(state, BACKUP_ID_1, "backup-one");
    await state.catalogDelegate.publishAvailability(await externalAvailability(
      state,
      BACKUP_ID_3,
      "external-before-restore",
      sha256("missing-restore-anchor"),
    ));
    const reserve = state.catalogAdapter.reserveRestore.bind(state.catalogAdapter);
    state.catalogAdapter.reserveRestore = vi.fn(async (input) => {
      expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_3)).not.toBeNull();
      return reserve(input);
    });

    await runBackupCatalogCli(
      ["prepare-restore"],
      prepareRestoreEnv(),
      state.dependencies,
    );

    expect(state.catalogAdapter.reserveRestore).toHaveBeenCalledOnce();
    expect(await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID))
      .toMatchObject({ phase: "reserved" });
  });

  it("does not reserve an external epoch when restore preflight fails", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await createAndPublish(state, BACKUP_ID_1, "backup-one");
    state.store.preflightTenantRestoreReplayFromBackup = vi.fn(async () => {
      throw new Error(RESPONSE_LOSS_MARKER);
    });
    const reserve = vi.spyOn(state.catalogAdapter, "reserveRestore");

    let failure: unknown;
    try {
      await runBackupCatalogCli(
        ["prepare-restore"],
        prepareRestoreEnv(),
        state.dependencies,
      );
    } catch (error) {
      failure = error;
    }

    expect(formatBackupCatalogCliError(failure))
      .toBe('{"status":"error","code":"operation_failed"}');
    expect(formatBackupCatalogCliError(failure)).not.toContain(RESPONSE_LOSS_MARKER);
    expect(reserve).not.toHaveBeenCalled();
    expect(await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID)).toBeNull();
  });

  it("atomically projects a restore reservation and exactly replays DB response loss", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await createAndPublish(state, BACKUP_ID_1, "backup-one");

    const originalPrepare = state.store.prepareTenantRestoreReplayFromBackup.bind(state.store);
    let loseResponse = true;
    state.store.prepareTenantRestoreReplayFromBackup = async (input) => {
      const result = await originalPrepare(input);
      if (loseResponse) {
        loseResponse = false;
        throw new Error(RESPONSE_LOSS_MARKER);
      }
      return result;
    };
    vi.mocked(state.storeClose).mockClear();
    vi.mocked(state.catalogAdapter.close).mockClear();
    vi.mocked(state.journalAdapter.close).mockClear();

    let failure: unknown;
    try {
      await runBackupCatalogCli(
        ["prepare-restore"],
        prepareRestoreEnv(),
        state.dependencies,
      );
    } catch (error) {
      failure = error;
    }
    expect(formatBackupCatalogCliError(failure))
      .toBe('{"status":"error","code":"operation_failed"}');
    expect(formatBackupCatalogCliError(failure)).not.toContain(RESPONSE_LOSS_MARKER);
    expect(await state.store.getTenantBackupRestoreSourceBinding(RESTORE_RUN_ID))
      .toMatchObject({ backupId: BACKUP_ID_1, restoreRunId: RESTORE_RUN_ID });
    expect(await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID))
      .toMatchObject({ phase: "reserved", restoreRunId: RESTORE_RUN_ID });
    expect(await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))
      .toMatchObject({ phase: "prepared", restoreRunId: RESTORE_RUN_ID });
    expect(state.storeClose).toHaveBeenCalledOnce();
    expect(state.catalogAdapter.close).toHaveBeenCalledOnce();
    expect(state.journalAdapter.close).toHaveBeenCalledOnce();

    await runBackupCatalogCli(
      ["prepare-restore"],
      prepareRestoreEnv(),
      state.dependencies,
    );
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "prepare-restore",
      disposition: "exact_replay",
      backupId: BACKUP_ID_1,
      restoreRunId: RESTORE_RUN_ID,
      restorePhase: "prepared",
    });
  });

  it("resolves a terminal restore and replays the terminal projection exactly", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await createAndPublish(state, BACKUP_ID_1, "backup-one");
    await runBackupCatalogCli(
      ["prepare-restore"],
      prepareRestoreEnv(),
      state.dependencies,
    );
    expect(await state.store.abortTenantRestoreReplay(RESTORE_RUN_ID)).toBe(true);
    const env = catalogEnv({
      RESTORE_RUN_ID,
      RESTORE_FLEET_STOPPED_ACK: "1",
    });
    await runBackupCatalogCli(["resolve-restore"], env, state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "resolve-restore",
      disposition: "created",
      restoreRunId: RESTORE_RUN_ID,
      phase: "aborted",
    });
    await runBackupCatalogCli(["resolve-restore"], env, state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "resolve-restore",
      disposition: "exact_replay",
      phase: "aborted",
    });
    expect(await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID))
      .toMatchObject({ phase: "aborted" });
  });

  it("enforces retention and external-head equality before eviction, then records it", async () => {
    const state = createHarness({ minimumRetentionMs: 100, minimumRecoverableBackups: 1 });
    await activateCatalog(state);
    await createAndPublish(state, BACKUP_ID_1, "backup-one");
    await createAndPublish(state, BACKUP_ID_2, "backup-two");
    const prepareEnv = catalogEnv({
      BACKUP_ID: BACKUP_ID_1,
      BACKUP_EVICTION_ID: EVICTION_ID,
      RESTORE_FLEET_STOPPED_ACK: "1",
    });
    let retentionFailure: unknown;
    try {
      await runBackupCatalogCli(["prepare-eviction"], prepareEnv, state.dependencies);
    } catch (error) {
      retentionFailure = error;
    }
    expect(formatBackupCatalogCliError(retentionFailure))
      .toBe('{"status":"error","code":"catalog_not_ready"}');

    state.clock.value += 101;
    await runBackupCatalogCli(["prepare-eviction"], prepareEnv, state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "prepare-eviction",
      evictionId: EVICTION_ID,
      backupId: BACKUP_ID_1,
      expectedCatalogSequence: 2,
    });
    const recordEnv = {
      ...prepareEnv,
      BACKUP_PHYSICAL_ABSENCE_ACK: "1",
      EXTERNAL_TOMBSTONE_SHA256: sha256("backup-one-external-tombstone"),
    };
    const originalRecord = state.store.recordTenantBackupCatalogEviction.bind(state.store);
    let loseDatabaseProjection = true;
    state.store.recordTenantBackupCatalogEviction = async (input) => {
      if (loseDatabaseProjection) {
        loseDatabaseProjection = false;
        throw new Error(RESPONSE_LOSS_MARKER);
      }
      return originalRecord(input);
    };
    let responseLoss: unknown;
    try {
      await runBackupCatalogCli(["record-eviction"], recordEnv, state.dependencies);
    } catch (error) {
      responseLoss = error;
    }
    expect(formatBackupCatalogCliError(responseLoss))
      .toBe('{"status":"error","code":"operation_failed"}');
    expect((await state.catalogDelegate.readHead()).catalogSequence).toBe(3);
    expect(await state.store.getTenantBackupCatalogEviction(BACKUP_ID_1)).toBeNull();

    await runBackupCatalogCli(["record-eviction"], recordEnv, state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "record-eviction",
      disposition: "created",
      backupId: BACKUP_ID_1,
      catalogSequence: 3,
    });
    await runBackupCatalogCli(["record-eviction"], recordEnv, state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "record-eviction",
      disposition: "exact_replay",
      backupId: BACKUP_ID_1,
      catalogSequence: 3,
    });
    expect(await state.store.getTenantBackupCatalogEviction(BACKUP_ID_1)).not.toBeNull();

    const headMismatch = createHarness({
      minimumRetentionMs: 0,
      minimumRecoverableBackups: 1,
    });
    await activateCatalog(headMismatch);
    await createAndPublish(headMismatch, BACKUP_ID_1, "backup-one");
    await createAndPublish(headMismatch, BACKUP_ID_2, "backup-two");
    const originalPrepare = headMismatch.store.prepareTenantBackupEviction.bind(
      headMismatch.store,
    );
    headMismatch.store.prepareTenantBackupEviction = async (input) => {
      const plan = await originalPrepare(input);
      await headMismatch.catalogDelegate.publishAvailability(await externalAvailability(
        headMismatch,
        BACKUP_ID_3,
        "external-race",
        sha256("external-race-anchor"),
      ));
      return plan;
    };
    let headFailure: unknown;
    try {
      await runBackupCatalogCli(
        ["prepare-eviction"],
        prepareEnv,
        headMismatch.dependencies,
      );
    } catch (error) {
      headFailure = error;
    }
    expect(formatBackupCatalogCliError(headFailure))
      .toBe('{"status":"error","code":"catalog_conflict"}');
    expect(await headMismatch.store.getTenantBackupCatalogEviction(BACKUP_ID_1)).toBeNull();
  });

  it("reconciles externally committed availability in bounded pages when anchors survive", async () => {
    const state = createHarness();
    await activateCatalog(state);
    for (const backupId of [BACKUP_ID_1, BACKUP_ID_2]) {
      await runBackupCatalogCli(
        ["begin-backup"],
        catalogEnv({ BACKUP_ID: backupId, RESTORE_FLEET_STOPPED_ACK: "1" }),
        state.dependencies,
      );
    }
    await state.catalogDelegate.publishAvailability(await externalAvailability(
      state,
      BACKUP_ID_1,
      "backup-one",
    ));
    await state.catalogDelegate.publishAvailability(await externalAvailability(
      state,
      BACKUP_ID_2,
      "backup-two",
    ));
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_1)).toBeNull();
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_2)).toBeNull();
    const scan = vi.spyOn(state.catalogAdapter, "scanEvents");
    const mirror = vi.spyOn(state.store, "mirrorTenantBackupCatalogEvent");

    await runBackupCatalogCli(
      ["reconcile"],
      catalogEnv({ BACKUP_CATALOG_PAGE_SIZE: "1" }),
      state.dependencies,
    );

    expect(JSON.parse(state.output.at(-1)!)).toEqual({
      status: "ok",
      command: "reconcile",
      eventCount: 2,
      projectedCount: 2,
    });
    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan.mock.calls.map(([input]) => input.limit)).toEqual([1, 1]);
    expect(mirror).toHaveBeenCalledTimes(2);
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_1)).not.toBeNull();
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_2)).not.toBeNull();
  });

  it("reconciles an externally committed activated resolution onto an active replay run", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await createAndPublish(state, BACKUP_ID_1, "backup-one");
    await runBackupCatalogCli(
      ["prepare-restore"],
      prepareRestoreEnv(),
      state.dependencies,
    );
    await state.store.sealTenantRestoreReplay(RESTORE_RUN_ID);
    const runtime = await state.store.getTenantRestoreRuntimeControl();
    if (runtime.state !== "active") throw new Error("expected an active primary runtime");
    await state.store.activateTenantRestoreRuntime({
      restoreRunId: RESTORE_RUN_ID,
      expectedControlGeneration: runtime.controlGeneration,
    });
    const reservation = await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID);
    if (!reservation) throw new Error("expected a durable restore reservation");
    await state.catalogDelegate.resolveRestore({
      restoreRunId: RESTORE_RUN_ID,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "activated",
    });
    expect(await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID))
      .toMatchObject({ phase: "reserved" });
    expect(await state.store.getTenantRestoreReplayRun(RESTORE_RUN_ID))
      .toMatchObject({ phase: "active" });

    await runBackupCatalogCli(["reconcile"], catalogEnv(), state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "reconcile",
      eventCount: 3,
      projectedCount: 3,
    });
    expect(await state.store.getTenantBackupRuntimeReservation(RESTORE_RUN_ID))
      .toMatchObject({ phase: "activated" });

    await runBackupCatalogCli(["reconcile"], catalogEnv(), state.dependencies);
    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "reconcile",
      eventCount: 3,
      projectedCount: 3,
    });
  });

  it("mirrors availability without local anchors and continues through the sealed chain", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await state.catalogDelegate.publishAvailability(await externalAvailability(
      state,
      BACKUP_ID_2,
      "external-two",
      sha256("missing-local-anchor-two"),
    ));
    await state.catalogDelegate.publishAvailability(await externalAvailability(
      state,
      BACKUP_ID_3,
      "external-three",
      sha256("missing-local-anchor-three"),
    ));
    const mirror = vi.spyOn(state.store, "mirrorTenantBackupCatalogEvent");

    await runBackupCatalogCli(["reconcile"], catalogEnv(), state.dependencies);

    expect(JSON.parse(state.output.at(-1)!)).toMatchObject({
      command: "reconcile",
      eventCount: 2,
      projectedCount: 2,
    });
    expect(mirror).toHaveBeenCalledTimes(2);
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_2)).not.toBeNull();
    expect(await state.store.getTenantBackupCatalogEntry(BACKUP_ID_3)).not.toBeNull();
  });

  it("formats dependency failures without content and closes every acquired resource", async () => {
    const state = createHarness();
    await activateCatalog(state);
    await createAndPublish(state, BACKUP_ID_1, "backup-one");
    state.catalogAdapter.inspectAvailability = vi.fn(async () => {
      throw new Error(RESPONSE_LOSS_MARKER);
    });
    vi.mocked(state.storeClose).mockClear();
    vi.mocked(state.catalogAdapter.close).mockClear();
    vi.mocked(state.journalAdapter.close).mockClear();

    let failure: unknown;
    try {
      await runBackupCatalogCli(
        ["prepare-restore"],
        prepareRestoreEnv(),
        state.dependencies,
      );
    } catch (error) {
      failure = error;
    }
    const formatted = formatBackupCatalogCliError(failure);
    expect(formatted).toBe('{"status":"error","code":"operation_failed"}');
    expect(formatted).not.toContain(RESPONSE_LOSS_MARKER);
    expect(state.storeClose).toHaveBeenCalledOnce();
    expect(state.catalogAdapter.close).toHaveBeenCalledOnce();
    expect(state.journalAdapter.close).toHaveBeenCalledOnce();
  });
});
