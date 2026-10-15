import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256, EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  S3TenantBackupCatalogAdapter, S3TenantRestoreJournalAdapter, assertEventChain,
  tenantRestoreJournalTargetRootSha256, tenantRestoreReplaySealedTargetRootSha256,
  validateScanTenantRestoreJournalRecordsResult, validateTenantBackupCatalogAdapterEvent,
  validateTenantBackupCatalogControlRecord, validateTenantBackupCatalogHead,
  validateTenantRestoreJournalControlRecord, validateTenantRestoreJournalRemoteHead,
  validateTenantRestoreReplaySealedTarget, validateTenantRestoreRuntimeControlRecord,
  type TenantBackupCatalogAdapterEvent, type TenantBackupSnapshotAnchor,
  type TenantBackupCatalogAdapter, type TenantRestoreJournalAdapter,
  type TenantTelemetryCaptureBackupCheckpointStore, type TenantTelemetryCaptureBackupSourceMaintenance,
} from "@agent-service/store";
import type { TenantRestoreJournalSourceObservationConfig } from "./tenant-restore-journal-config.js";
import { artifactFailure, canonicalJson } from "./mysql-backup-artifact-codec.js";

/** Opaque product assembly, not an operator-provided boolean/digest/callback.
 * Registration alone is not DB truth: the producer separately verifies the
 * exact actual pool/locked database and every physical checkpoint/lineage leaf. */
export interface MySqlBackupArtifactSourceObserver {
  readonly purpose: "mysql-backup-source-observer-v1";
}
type Step = <T>(operation: () => Promise<T>) => Promise<T>;
type ObservationIdentity = Omit<TenantRestoreJournalSourceObservationConfig, "targets"> & {
  targets: readonly { descriptor: TenantRestoreJournalSourceObservationConfig["targets"][number]["descriptor"] }[];
};
interface State {
  store: TenantTelemetryCaptureBackupSourceMaintenance;
  config: ObservationIdentity;
  catalog: S3TenantBackupCatalogAdapter;
  journals: readonly S3TenantRestoreJournalAdapter[];
  step: Step;
}
const observers = new WeakMap<MySqlBackupArtifactSourceObserver, State>();
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function reject(): never { return artifactFailure("capture_source_observation_invalid"); }

/** A budget wrapper may bound/deny an actual read, but cannot supply its proof.
 * Capture only the result of the exactly-once operation invoked while that
 * wrapper is open. Never await an unbounded read after a hostile early return;
 * its rejection remains observed and late callbacks cannot start new I/O. */
async function readThroughStep<T>(step: Step, operation: () => Promise<T>): Promise<T> {
  const invocation: { calls: number; closed: boolean; invalid: boolean;
    outcome: { kind: "pending" } | { kind: "fulfilled"; value: T } | { kind: "rejected"; error: unknown } } = {
      calls: 0, closed: false, invalid: false, outcome: { kind: "pending" },
    };
  const actual = (): Promise<T> => {
    invocation.calls += 1;
    if (invocation.closed || invocation.calls !== 1) {
      invocation.invalid = true;
      const denied = Promise.resolve().then(() => reject());
      void denied.catch(() => {});
      return denied;
    }
    const reading = (async () => {
      try {
        const value = await operation();
        // The wrapper receives the original value, not this private snapshot:
        // in-place mutation after await operation() cannot rewrite observed
        // content-free store/head/page evidence either.
        invocation.outcome = { kind: "fulfilled", value: structuredClone(value) };
        return value;
      } catch (error) {
        invocation.outcome = { kind: "rejected", error };
        throw error;
      }
    })();
    // A wrapper that ignores/catches this promise must not hide a read failure
    // or produce an unhandled rejection after the observation was rejected.
    void reading.catch(() => {});
    return reading;
  };
  try { await step(actual); }
  finally { invocation.closed = true; }
  if (invocation.invalid || invocation.calls !== 1 || invocation.outcome.kind === "pending") reject();
  if (invocation.outcome.kind === "rejected") throw invocation.outcome.error;
  return invocation.outcome.value;
}

export function createMySqlBackupArtifactSourceObserver(input: {
  store: TenantTelemetryCaptureBackupSourceMaintenance;
  config: TenantRestoreJournalSourceObservationConfig;
  catalog: TenantBackupCatalogAdapter;
  journals: readonly TenantRestoreJournalAdapter[];
  step: Step;
}): MySqlBackupArtifactSourceObserver {
  const catalog = input.catalog;
  if (input.config.purpose !== "backup-source-head-observation-v1"
    || !/^[0-9a-f]{64}$/.test(input.config.sourceRuntimeEpochSha256)
    || !(catalog instanceof S3TenantBackupCatalogAdapter)
    || typeof catalog.readHeadForBackupSourceObservation !== "function"
    || input.journals.length !== input.config.targets.length
    || typeof input.step !== "function") reject();
  const journals: S3TenantRestoreJournalAdapter[] = [];
  for (const journal of input.journals) {
    if (!(journal instanceof S3TenantRestoreJournalAdapter)) reject();
    journals.push(journal);
  }
  // No transport options/credentials are needed after adapter construction.
  const config: ObservationIdentity = {
    purpose: input.config.purpose, sourceRuntimeEpochSha256: input.config.sourceRuntimeEpochSha256,
    adapterProtocol: input.config.adapterProtocol, journalNamespaceSha256: input.config.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: input.config.logicalDatabaseNamespaceSha256, targetRootSha256: input.config.targetRootSha256,
    targets: input.config.targets.map((target) => ({ descriptor: { ...target.descriptor } })),
  };
  const observer = Object.freeze({ purpose: "mysql-backup-source-observer-v1" as const });
  observers.set(observer, { store: input.store, step: input.step, catalog, config, journals: Object.freeze(journals) });
  return observer;
}

/** Observation only: catalog GET-only CAS-head proof; journal v1 retains its
 * existing LIST discovery plus exact GET contiguous-chain/hole validation,
 * not an independent CAS authority. No startup probe, genesis creation, recovery,
 * event mirror, reservation or CAS is available through this capability. */
export async function assertMySqlBackupArtifactSourceObserved(observer: MySqlBackupArtifactSourceObserver | undefined,
  actualStore: TenantTelemetryCaptureBackupCheckpointStore, anchor: TenantBackupSnapshotAnchor): Promise<void> {
  const state = observer && observers.get(observer);
  if (!state || state.store !== actualStore) reject();
  const { store, config, catalog, journals } = state;
  const step: Step = (operation) => readThroughStep(state.step, operation);
  const readActual = async () => {
    const runtime = await step(() => store.getTenantRestoreRuntimeControl());
    const heads = await step(() => store.getTenantRestoreRuntimeHeads());
    const journal = await step(() => store.getTenantRestoreJournalControl());
    const targets = await step(() => store.getTenantRestoreJournalControlTargets());
    const control = await step(() => store.getTenantBackupCatalogControl());
    validateTenantRestoreRuntimeControlRecord(runtime); validateTenantRestoreJournalControlRecord(journal);
    validateTenantBackupCatalogControlRecord(control);
    for (const head of heads) validateTenantRestoreReplaySealedTarget(head);
    if (runtime.state !== "active" || journal.controlGeneration !== 1 || control.state !== "active"
      || runtime.runtimeEpochSha256 !== config.sourceRuntimeEpochSha256
      || runtime.runtimeEpochSha256 !== anchor.sourceRuntimeEpochSha256
      || runtime.controlGeneration !== anchor.sourceRuntimeControlGeneration
      || runtime.evidenceSha256 !== anchor.sourceRuntimeControlEvidenceSha256
      || runtime.controlEvidenceSha256 !== journal.evidenceSha256
      || runtime.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256
      || runtime.targetRootSha256 !== config.targetRootSha256 || runtime.targetCount !== config.targets.length
      || runtime.verifiedHeadRootSha256 !== anchor.sourceRuntimeHeadRootSha256
      || journal.evidenceSha256 !== anchor.journalControlEvidenceSha256
      || journal.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256
      || journal.adapterProtocol !== config.adapterProtocol || journal.journalNamespaceSha256 !== config.journalNamespaceSha256
      || journal.targetCount !== config.targets.length || journal.targetRootSha256 !== config.targetRootSha256
      || targets.length !== config.targets.length || heads.length !== config.targets.length
      || tenantRestoreJournalTargetRootSha256(targets) !== config.targetRootSha256
      || tenantRestoreReplaySealedTargetRootSha256(heads) !== anchor.sourceRuntimeHeadRootSha256
      || !same(heads, anchor.sourceRuntimeHeads)
      || control.evidenceSha256 !== anchor.controlEvidenceSha256
      || control.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256
      || control.journalControlEvidenceSha256 !== journal.evidenceSha256
      || control.adapterProtocol !== catalog.adapterProtocol || control.catalogNamespaceSha256 !== catalog.catalogNamespaceSha256
      || control.catalogTargetSha256 !== catalog.catalogTargetSha256 || control.failureDomainSha256 !== catalog.failureDomainSha256) reject();
    for (const [index, configured] of config.targets.entries()) {
      if (!same(targets[index], configured.descriptor)) reject();
      const adapter = journals[index];
      if (!adapter || adapter.targetSha256 !== configured.descriptor.targetSha256
        || adapter.failureDomainSha256 !== configured.descriptor.failureDomainSha256
        || adapter.adapterProtocol !== configured.descriptor.adapterProtocol
        || adapter.journalNamespaceSha256 !== configured.descriptor.journalNamespaceSha256
        || adapter.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256) reject();
    }
    return { runtime, heads, journal, targets, control };
  };
  const before = await readActual();
  const catalogHead = await step(() => catalog.readHeadForBackupSourceObservation());
  validateTenantBackupCatalogHead(catalogHead);
  if (catalogHead.catalogSequence !== anchor.sourceCatalogSequence
    || catalogHead.catalogEventRootSha256 !== anchor.sourceCatalogEventRootSha256
    || catalogHead.adapterProtocol !== catalog.adapterProtocol || catalogHead.catalogNamespaceSha256 !== catalog.catalogNamespaceSha256
    || catalogHead.catalogTargetSha256 !== catalog.catalogTargetSha256 || catalogHead.failureDomainSha256 !== catalog.failureDomainSha256) reject();
  const events: TenantBackupCatalogAdapterEvent[] = [];
  let sequence = 0, root = EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256;
  while (sequence < catalogHead.catalogSequence) {
    const page = await step(() => catalog.scanEvents({ sealedHead: catalogHead, afterCatalogSequence: sequence,
      afterCatalogEventRootSha256: root, limit: 100 }));
    if (!Array.isArray(page.events) || !page.events.length || page.events.length > 100) reject();
    for (const event of page.events) {
      validateTenantBackupCatalogAdapterEvent(event);
      if (event.result.catalogSequence !== sequence + 1 || event.result.previousCatalogEventRootSha256 !== root) reject();
      sequence = event.result.catalogSequence; root = event.result.catalogEventRootSha256; events.push(event);
    }
    if (sequence > catalogHead.catalogSequence || page.nextCatalogSequence !== sequence || page.nextCatalogEventRootSha256 !== root
      || page.complete !== (sequence === catalogHead.catalogSequence)) reject();
  }
  if (root !== catalogHead.catalogEventRootSha256) reject();
  assertEventChain({ adapterProtocol: catalogHead.adapterProtocol, catalogNamespaceSha256: catalogHead.catalogNamespaceSha256,
    catalogTargetSha256: catalogHead.catalogTargetSha256, failureDomainSha256: catalogHead.failureDomainSha256 }, events);
  for (const [index, adapter] of journals.entries()) {
    const head = await step(() => adapter.readHead()); validateTenantRestoreJournalRemoteHead(head);
    const expected = before.heads[index];
    if (!expected || head.adapterProtocol !== expected.adapterProtocol || head.journalNamespaceSha256 !== expected.journalNamespaceSha256
      || head.targetSha256 !== expected.targetSha256 || head.logicalDatabaseNamespaceSha256 !== expected.logicalDatabaseNamespaceSha256
      || head.remoteSequence !== expected.sealedRemoteSequence || head.headRootSha256 !== expected.sealedHeadRootSha256) reject();
    let after = 0, previous = EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256;
    while (after < head.remoteSequence) {
      const options = { sealedHead: head, afterRemoteSequence: after, afterHeadRootSha256: previous, limit: 100 };
      const page = await step(() => adapter.scanRecords(options));
      validateScanTenantRestoreJournalRecordsResult(options, page);
      if (!page.entries.length) reject();
      after = page.nextRemoteSequence; previous = page.nextHeadRootSha256;
    }
    if (previous !== head.headRootSha256 || !same(await step(() => adapter.readHead()), head)) reject();
  }
  if (!same(await step(() => catalog.readHeadForBackupSourceObservation()), catalogHead)
    || !same(await readActual(), before)) reject();
}
