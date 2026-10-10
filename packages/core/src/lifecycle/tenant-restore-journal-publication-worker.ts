import { randomUUID } from "node:crypto";
import {
  TenantErasureIntegrityError,
  TenantRestoreJournalConflictError,
  TenantRestoreJournalCorruptError,
  TenantRestoreJournalPublicationDependencyPendingError,
  tenantRestoreJournalClaimTokenSha256,
  tenantRestoreJournalPublicationTargetAckRootSha256,
  tenantRestoreJournalPublicationTargetRootSha256,
  tenantRestoreJournalRemoteCommitRootSha256,
  tenantRestoreJournalTargetRootSha256,
  validateTenantRestoreJournalAdapterResult,
  validateTenantRestoreJournalControlRecord,
  validateTenantRestoreJournalPublicationClaim,
  validateTenantRestoreJournalPublicationReceipt,
  validateTenantRestoreJournalPublicationTarget,
  validateTenantRestoreJournalPublicationTargetAck,
  validateTenantRestoreJournalRecord,
  validateTenantRestoreJournalTargetDescriptor,
  type TenantRestoreJournalAdapter,
  type TenantRestoreJournalAdapterResult,
  type TenantRestoreJournalPublicationAuthorization,
  type TenantRestoreJournalPublicationBlockReasonCode,
  type TenantRestoreJournalPublicationBundle,
  type TenantRestoreJournalPublicationClaim,
  type TenantRestoreJournalPublicationReceipt,
  type TenantRestoreJournalPublicationRetryErrorCode,
  type TenantRestoreJournalPublicationTarget,
  type TenantRestoreJournalPublicationTargetAck,
  type TenantRestoreJournalRecord,
  type TenantRestoreJournalStore,
  type TenantRestoreJournalTargetDescriptor,
} from "@agent-service/store";

class TenantRestoreJournalPublicationSourceConflictError extends Error {
  constructor() {
    super("tenant restore journal publication source conflict");
    this.name = "TenantRestoreJournalPublicationSourceConflictError";
  }
}

class TenantRestoreJournalPublicationRemoteConflictError extends Error {
  constructor() {
    super("tenant restore journal publication remote conflict");
    this.name = "TenantRestoreJournalPublicationRemoteConflictError";
  }
}

class TenantRestoreJournalPublicationTemporaryError extends Error {
  constructor() {
    super("tenant restore journal publication boundary is temporarily unavailable");
    this.name = "TenantRestoreJournalPublicationTemporaryError";
  }
}

export interface TenantRestoreJournalPublicationWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  materializeBatchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface TenantRestoreJournalPublicationWorkerDeps {
  store: TenantRestoreJournalStore;
  /** Adapters are ordered by the durable target ordinal. */
  adapters: readonly TenantRestoreJournalAdapter[];
  /** One non-sticky proof authorizes only the immediately following durable/remote boundary. */
  canExecute: () => Promise<boolean>;
  logger?: Pick<Console, "warn">;
}

const DEFAULTS = {
  pollIntervalMs: 1_000,
  leaseMs: 30_000,
  batchSize: 5,
  materializeBatchSize: 25,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
} as const;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function authorization(
  claim: TenantRestoreJournalPublicationClaim,
): TenantRestoreJournalPublicationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    publicationGeneration: claim.publicationGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function adapterDescriptor(
  adapter: TenantRestoreJournalAdapter,
  targetOrdinal: number,
): TenantRestoreJournalTargetDescriptor {
  const descriptor: TenantRestoreJournalTargetDescriptor = {
    targetOrdinal,
    targetSha256: adapter.targetSha256,
    failureDomainSha256: adapter.failureDomainSha256,
    adapterProtocol: adapter.adapterProtocol,
    journalNamespaceSha256: adapter.journalNamespaceSha256,
  };
  validateTenantRestoreJournalTargetDescriptor(descriptor);
  return descriptor;
}

function sameTarget(
  left: TenantRestoreJournalPublicationTarget,
  right: TenantRestoreJournalPublicationTarget,
): boolean {
  return left.requestId === right.requestId
    && left.tenantId === right.tenantId
    && left.subjectGeneration === right.subjectGeneration
    && left.publicationGeneration === right.publicationGeneration
    && left.scope === right.scope
    && left.targetOrdinal === right.targetOrdinal
    && left.targetSha256 === right.targetSha256
    && left.failureDomainSha256 === right.failureDomainSha256
    && left.adapterProtocol === right.adapterProtocol
    && left.journalNamespaceSha256 === right.journalNamespaceSha256
    && left.logicalDatabaseNamespaceSha256 === right.logicalDatabaseNamespaceSha256
    && left.t1FenceSha256 === right.t1FenceSha256
    && left.operationSha256 === right.operationSha256
    && left.recordSha256 === right.recordSha256
    && left.capturedAtDbMs === right.capturedAtDbMs
    && left.receiptSha256 === right.receiptSha256;
}

function recordMatchesTarget(
  record: TenantRestoreJournalRecord,
  target: TenantRestoreJournalPublicationTarget,
): boolean {
  return record.logicalDatabaseNamespaceSha256 === target.logicalDatabaseNamespaceSha256
    && record.requestId === target.requestId
    && record.tenantId === target.tenantId
    && record.subjectGeneration === target.subjectGeneration
    && record.t1FenceSha256 === target.t1FenceSha256
    && record.operationSha256 === target.operationSha256
    && record.recordSha256 === target.recordSha256;
}

function blockReason(error: unknown): TenantRestoreJournalPublicationBlockReasonCode | undefined {
  if (error instanceof TenantRestoreJournalConflictError
    || error instanceof TenantRestoreJournalCorruptError
    || error instanceof TenantRestoreJournalPublicationRemoteConflictError) {
    return "remote_conflict";
  }
  if (error instanceof TenantErasureIntegrityError
    || error instanceof TenantRestoreJournalPublicationSourceConflictError) {
    return "source_conflict";
  }
  return undefined;
}

/**
 * Publishes the pre-destructive T1 restore fence to every configured independent target. The
 * store owns claim fencing, target/ACK construction, exact replay, and terminal sealing; this
 * worker never logs backend errors, locators, tenant identities, or record contents.
 */
export class TenantRestoreJournalPublicationWorker {
  private readonly opts: Required<TenantRestoreJournalPublicationWorkerOptions>;
  private readonly log: Pick<Console, "warn">;
  private readonly adapters: readonly TenantRestoreJournalAdapter[];
  private readonly configuredTargetRootSha256: string;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly inFlight = new Set<Promise<number>>();
  private stopping = true;
  private shutdownRequested = false;
  private adaptersClosed = false;
  private stopPromise?: Promise<void>;

  constructor(
    private readonly deps: TenantRestoreJournalPublicationWorkerDeps,
    options: TenantRestoreJournalPublicationWorkerOptions = {},
  ) {
    this.opts = {
      pollIntervalMs: positiveInteger(
        options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
        "pollIntervalMs",
      ),
      leaseMs: positiveInteger(options.leaseMs ?? DEFAULTS.leaseMs, "leaseMs"),
      batchSize: positiveInteger(options.batchSize ?? DEFAULTS.batchSize, "batchSize"),
      materializeBatchSize: positiveInteger(
        options.materializeBatchSize ?? DEFAULTS.materializeBatchSize,
        "materializeBatchSize",
      ),
      retryBaseMs: positiveInteger(options.retryBaseMs ?? DEFAULTS.retryBaseMs, "retryBaseMs"),
      retryMaxMs: positiveInteger(options.retryMaxMs ?? DEFAULTS.retryMaxMs, "retryMaxMs"),
    };
    if (this.opts.batchSize > 100 || this.opts.materializeBatchSize > 100) {
      throw new Error("tenant restore journal publication batch sizes must not exceed 100");
    }
    if (this.opts.retryMaxMs < this.opts.retryBaseMs) {
      throw new Error("retryMaxMs must be >= retryBaseMs");
    }
    this.adapters = Object.freeze([...deps.adapters]);
    if (this.adapters.length < 1 || this.adapters.length > 32) {
      throw new Error("tenant restore journal publication requires between one and 32 adapters");
    }
    try {
      const descriptors = this.adapters.map(adapterDescriptor);
      this.configuredTargetRootSha256 = tenantRestoreJournalTargetRootSha256(descriptors);
      const first = this.adapters[0]!;
      if (this.adapters.some((adapter) => (
        adapter.logicalDatabaseNamespaceSha256 !== first.logicalDatabaseNamespaceSha256
      ))) throw new Error("adapter database namespaces differ");
    } catch {
      throw new Error("tenant restore journal publication adapter catalog is invalid");
    }
    this.log = deps.logger ?? console;
  }

  start(): void {
    if (!this.stopping) return;
    if (this.shutdownRequested || this.stopPromise || this.adaptersClosed) {
      throw new Error("tenant restore journal publication worker is closed");
    }
    this.stopping = false;
    this.schedule(0);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.shutdownRequested = true;
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }

  processOnce(): Promise<number> {
    const run = this.runOnce();
    this.inFlight.add(run);
    void run.then(
      () => this.inFlight.delete(run),
      () => this.inFlight.delete(run),
    );
    return run;
  }

  private async finishStop(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
    if (this.adaptersClosed) return;
    this.adaptersClosed = true;
    const results = await Promise.allSettled(this.adapters.map((adapter) => adapter.close()));
    if (results.some((result) => result.status === "rejected")) {
      this.log.warn("[tenant-restore-journal-publication-worker] adapter close failed");
    }
  }

  private async runOnce(): Promise<number> {
    if (!await this.freshGate()) return 0;
    try {
      await this.deps.store.materializeTenantRestoreJournalPublicationJobs({
        limit: this.opts.materializeBatchSize,
      });
    } catch {
      this.log.warn("[tenant-restore-journal-publication-worker] materialization failed");
    }

    if (!await this.freshGate()) return 0;
    let claims: TenantRestoreJournalPublicationClaim[];
    try {
      claims = await this.deps.store.claimTenantRestoreJournalPublications({
        limit: this.opts.batchSize,
        leaseMs: this.opts.leaseMs,
        claimToken: randomUUID(),
      });
    } catch {
      this.log.warn("[tenant-restore-journal-publication-worker] claim failed");
      return 0;
    }
    if (this.shutdownRequested) return 0;

    let completed = 0;
    for (const claim of claims) {
      if (this.shutdownRequested) break;
      try {
        try {
          validateTenantRestoreJournalPublicationClaim(claim);
        } catch {
          throw new TenantRestoreJournalPublicationSourceConflictError();
        }
        if (await this.advance(claim)) completed += 1;
      } catch (error) {
        this.log.warn("[tenant-restore-journal-publication-worker] publication failed");
        const reason = blockReason(error);
        if (reason !== undefined) {
          await this.block(claim, reason).catch(() => false);
        } else if (!this.shutdownRequested) {
          const errorCode: TenantRestoreJournalPublicationRetryErrorCode =
            error instanceof TenantRestoreJournalPublicationDependencyPendingError
              ? "dependency_pending"
              : "temporary_failure";
          await this.retry(claim, errorCode).catch(() => false);
        }
      }
    }
    return completed;
  }

  private async advance(claim: TenantRestoreJournalPublicationClaim): Promise<boolean> {
    const auth = authorization(claim);
    await this.requireRenewAfterFreshGate(auth);
    const catalog = await this.loadAndValidateCatalog(claim);
    const initialBundle = await this.deps.store.getTenantRestoreJournalPublicationBundle(
      claim.tenantId,
      claim.requestId,
    );
    const { targets, ackByOrdinal } = this.validateBundle(claim, catalog, initialBundle);

    for (const target of targets) {
      if (ackByOrdinal.has(target.targetOrdinal)) continue;
      if (this.shutdownRequested) throw new TenantRestoreJournalPublicationTemporaryError();
      const publication = await this.deps.store.getTenantRestoreJournalPublicationRecord(
        auth,
        target.targetOrdinal,
      );
      if (!publication) throw new TenantRestoreJournalPublicationTemporaryError();
      this.validatePublicationRecord(target, publication.target, publication.record);

      const adapter = this.adapters[target.targetOrdinal];
      if (!adapter) throw new TenantRestoreJournalPublicationSourceConflictError();
      await this.requireRenewAfterFreshGate(auth);
      this.validateAdapterIdentity(adapter, target);
      let result = await adapter.inspectRecord(publication.record);
      if (result) this.validateAdapterResult(adapter, target, publication.record, result, true);
      if (!result) {
        result = await this.publishWithExactInspection(
          auth,
          adapter,
          target,
          publication.record,
        );
      }
      await this.requireRenewAfterFreshGate(auth);
      const ack = await this.recordAckWithExactReplay(
        auth,
        target,
        publication.record,
        result,
      );
      ackByOrdinal.set(target.targetOrdinal, ack);
    }

    const finalBundle = await this.deps.store.getTenantRestoreJournalPublicationBundle(
      claim.tenantId,
      claim.requestId,
    );
    const final = this.validateBundle(claim, catalog, finalBundle);
    if (final.ackByOrdinal.size !== targets.length) {
      throw new TenantRestoreJournalPublicationDependencyPendingError();
    }
    await this.requireRenewAfterFreshGate(auth);
    return this.sealWithExactReplay(auth, claim, [...final.ackByOrdinal.values()]);
  }

  private async loadAndValidateCatalog(
    claim: TenantRestoreJournalPublicationClaim,
  ): Promise<TenantRestoreJournalTargetDescriptor[]> {
    try {
      const control = await this.deps.store.getTenantRestoreJournalControl();
      validateTenantRestoreJournalControlRecord(control);
      if (control.controlGeneration !== 1
        || control.evidenceSha256 !== claim.controlEvidenceSha256
        || control.adapterProtocol !== claim.adapterProtocol
        || control.journalNamespaceSha256 !== claim.journalNamespaceSha256
        || control.logicalDatabaseNamespaceSha256 !== claim.logicalDatabaseNamespaceSha256
        || control.targetCount !== claim.targetCount
        || control.targetRootSha256 !== claim.targetRootSha256
        || control.activatedAtDbMs > claim.sourceEvidenceDbMs) {
        throw new Error("control mismatch");
      }
      const catalog = (await this.deps.store.getTenantRestoreJournalControlTargets())
        .sort((left, right) => left.targetOrdinal - right.targetOrdinal);
      if (catalog.length !== claim.targetCount
        || claim.targetCount !== this.adapters.length
        || tenantRestoreJournalTargetRootSha256(catalog) !== claim.targetRootSha256
        || claim.targetRootSha256 !== this.configuredTargetRootSha256) {
        throw new Error("catalog mismatch");
      }
      for (const [ordinal, configured] of catalog.entries()) {
        validateTenantRestoreJournalTargetDescriptor(configured);
        const current = adapterDescriptor(this.adapters[ordinal]!, ordinal);
        if (configured.targetOrdinal !== ordinal
          || configured.targetSha256 !== current.targetSha256
          || configured.failureDomainSha256 !== current.failureDomainSha256
          || configured.adapterProtocol !== current.adapterProtocol
          || configured.journalNamespaceSha256 !== current.journalNamespaceSha256
          || this.adapters[ordinal]!.logicalDatabaseNamespaceSha256
            !== claim.logicalDatabaseNamespaceSha256) {
          throw new Error("adapter mismatch");
        }
      }
      return catalog;
    } catch (error) {
      if (error instanceof TenantErasureIntegrityError) throw error;
      throw new TenantRestoreJournalPublicationSourceConflictError();
    }
  }

  private validateBundle(
    claim: TenantRestoreJournalPublicationClaim,
    catalog: readonly TenantRestoreJournalTargetDescriptor[],
    bundle: TenantRestoreJournalPublicationBundle | null,
  ): {
      targets: TenantRestoreJournalPublicationTarget[];
      ackByOrdinal: Map<number, TenantRestoreJournalPublicationTargetAck>;
    } {
    try {
      if (!bundle || bundle.receipt || bundle.targets.length !== claim.targetCount) {
        throw new Error("bundle is incomplete or terminal");
      }
      const targets = [...bundle.targets].sort(
        (left, right) => left.targetOrdinal - right.targetOrdinal,
      );
      tenantRestoreJournalPublicationTargetRootSha256(targets);
      for (const [ordinal, target] of targets.entries()) {
        validateTenantRestoreJournalPublicationTarget(target);
        const configured = catalog[ordinal];
        const adapter = this.adapters[ordinal];
        if (!configured || !adapter
          || target.targetOrdinal !== ordinal
          || target.requestId !== claim.requestId
          || target.tenantId !== claim.tenantId
          || target.subjectGeneration !== claim.subjectGeneration
          || target.publicationGeneration !== claim.publicationGeneration
          || target.t1FenceSha256 !== claim.t1FenceSha256
          || target.targetSha256 !== configured.targetSha256
          || target.failureDomainSha256 !== configured.failureDomainSha256
          || target.adapterProtocol !== claim.adapterProtocol
          || target.adapterProtocol !== configured.adapterProtocol
          || target.adapterProtocol !== adapter.adapterProtocol
          || target.journalNamespaceSha256 !== claim.journalNamespaceSha256
          || target.journalNamespaceSha256 !== configured.journalNamespaceSha256
          || target.journalNamespaceSha256 !== adapter.journalNamespaceSha256
          || target.logicalDatabaseNamespaceSha256 !== claim.logicalDatabaseNamespaceSha256
          || target.logicalDatabaseNamespaceSha256 !== adapter.logicalDatabaseNamespaceSha256
          || target.capturedAtDbMs !== claim.sourceEvidenceDbMs) {
          throw new Error("target mismatch");
        }
      }
      tenantRestoreJournalPublicationTargetAckRootSha256(bundle.targetAcks);
      tenantRestoreJournalRemoteCommitRootSha256(bundle.targetAcks);
      const ackByOrdinal = new Map<number, TenantRestoreJournalPublicationTargetAck>();
      for (const ack of bundle.targetAcks) {
        validateTenantRestoreJournalPublicationTargetAck(ack);
        const target = targets[ack.targetOrdinal];
        if (!target || ackByOrdinal.has(ack.targetOrdinal)
          || ack.requestId !== claim.requestId
          || ack.tenantId !== claim.tenantId
          || ack.subjectGeneration !== claim.subjectGeneration
          || ack.publicationGeneration !== claim.publicationGeneration
          || ack.targetSha256 !== target.targetSha256
          || ack.failureDomainSha256 !== target.failureDomainSha256
          || ack.targetReceiptSha256 !== target.receiptSha256
          || ack.operationSha256 !== target.operationSha256
          || ack.recordSha256 !== target.recordSha256
          || ack.adapterProtocol !== target.adapterProtocol
          || ack.journalNamespaceSha256 !== target.journalNamespaceSha256
          || ack.logicalDatabaseNamespaceSha256 !== target.logicalDatabaseNamespaceSha256
          || ack.completedClaimAttempt > claim.claimAttempt
          || ack.storeDbTimestampMs < target.capturedAtDbMs) {
          throw new Error("ACK mismatch");
        }
        ackByOrdinal.set(ack.targetOrdinal, ack);
      }
      return { targets, ackByOrdinal };
    } catch (error) {
      if (error instanceof TenantErasureIntegrityError) throw error;
      throw new TenantRestoreJournalPublicationSourceConflictError();
    }
  }

  private validatePublicationRecord(
    expectedTarget: TenantRestoreJournalPublicationTarget,
    target: TenantRestoreJournalPublicationTarget,
    record: TenantRestoreJournalRecord,
  ): void {
    try {
      validateTenantRestoreJournalPublicationTarget(target);
      validateTenantRestoreJournalRecord(record);
      if (!sameTarget(target, expectedTarget) || !recordMatchesTarget(record, expectedTarget)) {
        throw new Error("publication record mismatch");
      }
    } catch {
      throw new TenantRestoreJournalPublicationSourceConflictError();
    }
  }

  private validateAdapterResult(
    adapter: TenantRestoreJournalAdapter,
    target: TenantRestoreJournalPublicationTarget,
    record: TenantRestoreJournalRecord,
    result: TenantRestoreJournalAdapterResult,
    inspected = false,
  ): void {
    try {
      validateTenantRestoreJournalAdapterResult(result);
      if (adapter.adapterProtocol !== target.adapterProtocol
        || adapter.journalNamespaceSha256 !== target.journalNamespaceSha256
        || adapter.targetSha256 !== target.targetSha256
        || adapter.failureDomainSha256 !== target.failureDomainSha256
        || adapter.logicalDatabaseNamespaceSha256 !== target.logicalDatabaseNamespaceSha256
        || result.adapterProtocol !== target.adapterProtocol
        || result.journalNamespaceSha256 !== target.journalNamespaceSha256
        || result.targetSha256 !== target.targetSha256
        || result.logicalDatabaseNamespaceSha256 !== target.logicalDatabaseNamespaceSha256
        || !recordMatchesTarget(result.record, target)
        || result.record.recordSha256 !== record.recordSha256
        || (inspected && result.replayed !== true)) {
        throw new Error("adapter result mismatch");
      }
    } catch {
      throw new TenantRestoreJournalPublicationRemoteConflictError();
    }
  }

  private validateAdapterIdentity(
    adapter: TenantRestoreJournalAdapter,
    target: TenantRestoreJournalPublicationTarget,
  ): void {
    try {
      const current = adapterDescriptor(adapter, target.targetOrdinal);
      if (current.targetSha256 !== target.targetSha256
        || current.failureDomainSha256 !== target.failureDomainSha256
        || current.adapterProtocol !== target.adapterProtocol
        || current.journalNamespaceSha256 !== target.journalNamespaceSha256
        || adapter.logicalDatabaseNamespaceSha256 !== target.logicalDatabaseNamespaceSha256) {
        throw new Error("adapter identity changed");
      }
    } catch {
      throw new TenantRestoreJournalPublicationSourceConflictError();
    }
  }

  private async publishWithExactInspection(
    auth: TenantRestoreJournalPublicationAuthorization,
    adapter: TenantRestoreJournalAdapter,
    target: TenantRestoreJournalPublicationTarget,
    record: TenantRestoreJournalRecord,
  ): Promise<TenantRestoreJournalAdapterResult> {
    await this.requireRenewAfterFreshGate(auth);
    this.validateAdapterIdentity(adapter, target);
    try {
      const result = await adapter.publishRecord(record);
      this.validateAdapterResult(adapter, target, record, result);
      return result;
    } catch (firstError) {
      if (blockReason(firstError) !== undefined) throw firstError;
      await this.requireRenewAfterFreshGate(auth);
      this.validateAdapterIdentity(adapter, target);
      try {
        const replay = await adapter.inspectRecord(record);
        if (replay) {
          this.validateAdapterResult(adapter, target, record, replay, true);
          return replay;
        }
      } catch (inspectionError) {
        if (blockReason(inspectionError) !== undefined) throw inspectionError;
      }
      throw firstError;
    }
  }

  private async recordAckWithExactReplay(
    auth: TenantRestoreJournalPublicationAuthorization,
    target: TenantRestoreJournalPublicationTarget,
    record: TenantRestoreJournalRecord,
    result: TenantRestoreJournalAdapterResult,
  ): Promise<TenantRestoreJournalPublicationTargetAck> {
    const exactResult = structuredClone(result);
    const commit = async (): Promise<TenantRestoreJournalPublicationTargetAck> => {
      const ack = await this.deps.store.recordTenantRestoreJournalPublicationTargetAck(
        auth,
        structuredClone(exactResult),
      );
      if (!ack) throw new TenantRestoreJournalPublicationTemporaryError();
      this.validateRecordedAck(auth, target, record, exactResult, ack);
      return ack;
    };
    try {
      return await commit();
    } catch (firstError) {
      if (firstError instanceof TenantRestoreJournalPublicationDependencyPendingError) {
        throw firstError;
      }
      if (blockReason(firstError) !== undefined) throw firstError;
      await this.requireRenewAfterFreshGate(auth);
      try {
        return await commit();
      } catch (replayError) {
        if (blockReason(replayError) !== undefined) throw replayError;
        throw firstError;
      }
    }
  }

  private validateRecordedAck(
    auth: TenantRestoreJournalPublicationAuthorization,
    target: TenantRestoreJournalPublicationTarget,
    record: TenantRestoreJournalRecord,
    result: TenantRestoreJournalAdapterResult,
    ack: TenantRestoreJournalPublicationTargetAck,
  ): void {
    try {
      validateTenantRestoreJournalPublicationTargetAck(ack);
      if (ack.requestId !== auth.requestId
        || ack.tenantId !== auth.tenantId
        || ack.subjectGeneration !== auth.subjectGeneration
        || ack.publicationGeneration !== auth.publicationGeneration
        || ack.targetOrdinal !== target.targetOrdinal
        || ack.targetSha256 !== target.targetSha256
        || ack.failureDomainSha256 !== target.failureDomainSha256
        || ack.targetReceiptSha256 !== target.receiptSha256
        || ack.operationSha256 !== record.operationSha256
        || ack.recordSha256 !== record.recordSha256
        || ack.adapterProtocol !== result.adapterProtocol
        || ack.journalNamespaceSha256 !== result.journalNamespaceSha256
        || ack.logicalDatabaseNamespaceSha256 !== result.logicalDatabaseNamespaceSha256
        || ack.remoteSequence !== result.remoteSequence
        || ack.previousHeadRootSha256 !== result.previousHeadRootSha256
        || ack.headRootSha256 !== result.headRootSha256
        || ack.completedClaimAttempt !== auth.claimAttempt
        || ack.completedClaimTokenSha256
          !== tenantRestoreJournalClaimTokenSha256(auth.claimToken)
        || ack.storeDbTimestampMs < target.capturedAtDbMs) {
        throw new Error("recorded ACK mismatch");
      }
    } catch (error) {
      if (error instanceof TenantErasureIntegrityError) throw error;
      throw new TenantRestoreJournalPublicationSourceConflictError();
    }
  }

  private async sealWithExactReplay(
    auth: TenantRestoreJournalPublicationAuthorization,
    claim: TenantRestoreJournalPublicationClaim,
    acks: readonly TenantRestoreJournalPublicationTargetAck[],
  ): Promise<boolean> {
    const commit = async (): Promise<TenantRestoreJournalPublicationReceipt> => {
      const receipt = await this.deps.store.sealTenantRestoreJournalPublication(auth);
      if (!receipt) throw new TenantRestoreJournalPublicationDependencyPendingError();
      this.validateReceipt(claim, acks, receipt);
      return receipt;
    };
    try {
      await commit();
      return true;
    } catch (firstError) {
      if (blockReason(firstError) !== undefined) throw firstError;
      // A committed seal is already terminal, so its claim can no longer be renewed. Reacquire a
      // fresh fleet proof and replay the exact authorization directly; the store accepts it only
      // when the terminal receipt was committed by this same claim attempt/token.
      if (!await this.freshGate()) throw new TenantRestoreJournalPublicationTemporaryError();
      try {
        await commit();
        return true;
      } catch (replayError) {
        if (blockReason(replayError) !== undefined) throw replayError;
        throw firstError;
      }
    }
  }

  private validateReceipt(
    claim: TenantRestoreJournalPublicationClaim,
    acks: readonly TenantRestoreJournalPublicationTargetAck[],
    receipt: TenantRestoreJournalPublicationReceipt,
  ): void {
    try {
      validateTenantRestoreJournalPublicationReceipt(receipt);
      if (receipt.requestId !== claim.requestId
        || receipt.tenantId !== claim.tenantId
        || receipt.subjectGeneration !== claim.subjectGeneration
        || receipt.publicationGeneration !== claim.publicationGeneration
        || receipt.t1FenceSha256 !== claim.t1FenceSha256
        || receipt.controlEvidenceSha256 !== claim.controlEvidenceSha256
        || receipt.adapterProtocol !== claim.adapterProtocol
        || receipt.journalNamespaceSha256 !== claim.journalNamespaceSha256
        || receipt.logicalDatabaseNamespaceSha256 !== claim.logicalDatabaseNamespaceSha256
        || receipt.targetCount !== claim.targetCount
        || receipt.targetRootSha256 !== claim.targetRootSha256
        || receipt.sourceEvidenceDbMs !== claim.sourceEvidenceDbMs
        || receipt.targetAckCount !== acks.length
        || receipt.targetAckRootSha256
          !== tenantRestoreJournalPublicationTargetAckRootSha256(acks)
        || receipt.remoteCommitCount !== acks.length
        || receipt.remoteCommitRootSha256 !== tenantRestoreJournalRemoteCommitRootSha256(acks)
        || receipt.completedClaimAttempt !== claim.claimAttempt
        || receipt.completedClaimTokenSha256
          !== tenantRestoreJournalClaimTokenSha256(claim.claimToken)) {
        throw new Error("terminal receipt mismatch");
      }
    } catch (error) {
      if (error instanceof TenantErasureIntegrityError) throw error;
      throw new TenantRestoreJournalPublicationSourceConflictError();
    }
  }

  private async requireRenewAfterFreshGate(
    auth: TenantRestoreJournalPublicationAuthorization,
  ): Promise<void> {
    if (!await this.freshGate()) throw new TenantRestoreJournalPublicationTemporaryError();
    let renewed: boolean;
    try {
      renewed = await this.deps.store.renewTenantRestoreJournalPublication(auth, {
        leaseMs: this.opts.leaseMs,
      });
    } catch (error) {
      if (error instanceof TenantErasureIntegrityError) throw error;
      throw new TenantRestoreJournalPublicationTemporaryError();
    }
    if (!renewed || this.shutdownRequested) {
      throw new TenantRestoreJournalPublicationTemporaryError();
    }
  }

  private async block(
    claim: TenantRestoreJournalPublicationClaim,
    reason: TenantRestoreJournalPublicationBlockReasonCode,
  ): Promise<boolean> {
    if (this.shutdownRequested) return false;
    const auth = authorization(claim);
    try {
      await this.requireRenewAfterFreshGate(auth);
      return await this.deps.store.blockTenantRestoreJournalPublication(auth, reason);
    } catch {
      return false;
    }
  }

  private async retry(
    claim: TenantRestoreJournalPublicationClaim,
    errorCode: TenantRestoreJournalPublicationRetryErrorCode,
  ): Promise<boolean> {
    if (this.shutdownRequested) return false;
    const exponent = Math.min(30, Math.max(0, claim.claimAttempt - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    return this.deps.store.retryTenantRestoreJournalPublication(authorization(claim), {
      delayMs,
      errorCode,
    });
  }

  private async freshGate(): Promise<boolean> {
    if (this.shutdownRequested) return false;
    try {
      const allowed = await this.deps.canExecute();
      return allowed && !this.shutdownRequested;
    } catch {
      return false;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const run = this.processOnce();
      void run
        .catch(() => this.log.warn("[tenant-restore-journal-publication-worker] polling failed"))
        .finally(() => this.schedule(this.opts.pollIntervalMs));
    }, delayMs);
    this.timer.unref?.();
  }
}
