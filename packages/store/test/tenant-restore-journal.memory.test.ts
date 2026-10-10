import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_AUTH_POLICY } from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  EMPTY_TENANT_RESTORE_RUNTIME_CONTROL_EVIDENCE_SHA256,
  MemorySessionStore,
  SubjectDeletingError,
  TENANT_RESTORE_JOURNAL_PROTOCOL,
  TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
  TenantErasureIntegrityError,
  TenantRestoreJournalPublicationDependencyPendingError,
  newErasureRequestId,
  newUserDataExportRequestId,
  tenantErasureRequestHash,
  tenantRestoreJournalNextRemoteHeadRootSha256,
  tenantRestoreJournalOperationSha256,
  tenantRestoreJournalRecordSha256,
  tenantRestoreLogicalDatabaseNamespaceSha256,
  tenantRestoreReplaySealedTargetRootSha256,
  tenantRestoreReplayReceiptSha256,
  tenantRestoreRuntimeEpochSha256,
  tenantRestoreRuntimeControlEvidenceSha256,
  userDataExportIdempotencyKeySha256,
  userDataExportRequestHash,
  validateTenantRestoreJournalRecord,
  type TenantCredentialRevocationAuthorization,
  type TenantRestoreJournalAdapterResult,
  type TenantRestoreJournalPublicationAuthorization,
  type TenantRestoreJournalRecord,
  type TenantRestoreJournalRemoteEntry,
  type TenantRestoreJournalTargetDescriptor,
  type TenantRestoreReplaySealedTarget,
} from "../src/index.js";
import { mkSession } from "./conformance.js";

function sha256(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function restoreRunId(): string {
  return `restore_${randomUUID()}`;
}

function targets(count: number): TenantRestoreJournalTargetDescriptor[] {
  return Array.from({ length: count }, (_, targetOrdinal) => ({
    targetOrdinal,
    targetSha256: sha256(`target-${targetOrdinal}`),
    // Repeated failure domains are allowed; every configured target still has to ACK.
    failureDomainSha256: sha256("shared-failure-domain"),
    adapterProtocol: "memory-restore-journal-v1",
    journalNamespaceSha256: sha256("journal-namespace"),
  }));
}

function emptyHeads(
  configured: readonly TenantRestoreJournalTargetDescriptor[],
  logicalDatabaseNamespaceSha256: string,
): TenantRestoreReplaySealedTarget[] {
  return configured.map((target) => ({
    ...target,
    logicalDatabaseNamespaceSha256,
    sealedRemoteSequence: 0,
    sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  }));
}

async function activate(
  store: MemorySessionStore,
  count = 1,
  epoch = "primary-epoch",
): Promise<{
  configured: TenantRestoreJournalTargetDescriptor[];
  logicalDatabaseNamespaceSha256: string;
  runtimeEpochSha256: string;
}> {
  const configured = targets(count);
  const logicalDatabaseNamespaceSha256 =
    tenantRestoreLogicalDatabaseNamespaceSha256("logical-database-main");
  const runtimeEpochSha256 = tenantRestoreRuntimeEpochSha256(epoch);
  await store.activateTenantRestoreJournalControl({
    adapterProtocol: configured[0]!.adapterProtocol,
    journalNamespaceSha256: configured[0]!.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256,
    runtimeEpochSha256,
    targets: configured,
    observedHeads: emptyHeads(configured, logicalDatabaseNamespaceSha256),
  });
  return { configured, logicalDatabaseNamespaceSha256, runtimeEpochSha256 };
}

function requestInput(tenantId: string, atMs: number) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    requestedByKeyId: "restore-journal-test",
    idempotencyKey: `erase-${tenantId}-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs,
  };
}

function publicationAuthorization(
  claim: Awaited<ReturnType<MemorySessionStore["claimTenantRestoreJournalPublications"]>>[number],
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

function revocationAuthorization(
  claim: Awaited<ReturnType<MemorySessionStore["claimTenantCredentialRevocations"]>>[number],
): TenantCredentialRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function appendResult(
  target: TenantRestoreJournalTargetDescriptor,
  logicalDatabaseNamespaceSha256: string,
  record: TenantRestoreJournalRecord,
  remoteSequence = 1,
  previousHeadRootSha256 = EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
): TenantRestoreJournalAdapterResult {
  const headRootSha256 = tenantRestoreJournalNextRemoteHeadRootSha256({
    previousHeadRootSha256,
    targetSha256: target.targetSha256,
    remoteSequence,
    operationSha256: record.operationSha256,
    recordSha256: record.recordSha256,
  });
  return {
    adapterProtocol: target.adapterProtocol,
    journalNamespaceSha256: target.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256,
    targetSha256: target.targetSha256,
    remoteSequence,
    previousHeadRootSha256,
    headRootSha256,
    record,
    replayed: false,
  };
}

function remoteEntry(result: TenantRestoreJournalAdapterResult): TenantRestoreJournalRemoteEntry {
  return {
    targetSha256: result.targetSha256,
    remoteSequence: result.remoteSequence,
    previousHeadRootSha256: result.previousHeadRootSha256,
    headRootSha256: result.headRootSha256,
    record: structuredClone(result.record),
  };
}

function standaloneRecord(
  logicalDatabaseNamespaceSha256: string,
  tenantId: string,
): TenantRestoreJournalRecord {
  const requestId = newErasureRequestId();
  const t1FenceSha256 = sha256(`t1-${tenantId}`);
  const operationSha256 = tenantRestoreJournalOperationSha256({
    logicalDatabaseNamespaceSha256,
    requestId,
    tenantId,
    subjectGeneration: 1,
    t1FenceSha256,
  });
  const body = {
    scope: TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
    protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
    logicalDatabaseNamespaceSha256,
    requestId,
    tenantId,
    subjectGeneration: 1,
    t1FenceSha256,
    operationSha256,
  };
  return { ...body, recordSha256: tenantRestoreJournalRecordSha256(body) };
}

class FailOnceMap<K, V> extends Map<K, V> {
  private fail = true;

  override set(key: K, value: V): this {
    if (this.fail) {
      this.fail = false;
      throw new Error("injected map serialization failure");
    }
    return super.set(key, value);
  }
}

function restoreMap<K, V>(target: Map<K, V>, snapshot: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, structuredClone(value));
}

describe("MemorySessionStore tenant restore journal", () => {
  it("binds every sealed-target namespace field into the head root", () => {
    const [head] = emptyHeads(
      targets(1),
      tenantRestoreLogicalDatabaseNamespaceSha256("sealed-root-database"),
    );
    const root = tenantRestoreReplaySealedTargetRootSha256([head!]);
    for (const changed of [
      { ...head!, adapterProtocol: "memory-restore-journal-v2" },
      { ...head!, journalNamespaceSha256: sha256("other-journal-namespace") },
      { ...head!, logicalDatabaseNamespaceSha256: sha256("other-logical-database") },
    ]) {
      expect(tenantRestoreReplaySealedTargetRootSha256([changed])).not.toBe(root);
    }
  });

  it("starts dormant and atomically activates an empty primary epoch", async () => {
    const store = new MemorySessionStore({ now: () => 10_000 });
    expect(await store.getTenantRestoreJournalControl()).toEqual({
      singletonId: 1,
      controlGeneration: 0,
    });
    expect(await store.getTenantRestoreRuntimeControl()).toEqual({
      singletonId: 1,
      state: "inactive",
      controlGeneration: 0,
    });

    const { configured, logicalDatabaseNamespaceSha256, runtimeEpochSha256 } =
      await activate(store, 2);
    expect(await store.getTenantRestoreJournalControl()).toMatchObject({
      controlGeneration: 1,
      targetCount: 2,
    });
    expect(await store.getTenantRestoreRuntimeControl()).toMatchObject({
      state: "active",
      controlGeneration: 1,
      updateKind: "primary_activation",
      lineageKind: "primary",
      runtimeEpochSha256,
    });
    expect(await store.getTenantRestoreRuntimeHeads()).toEqual(
      emptyHeads(configured, logicalDatabaseNamespaceSha256),
    );

    const nonempty = emptyHeads(configured, logicalDatabaseNamespaceSha256);
    nonempty[0] = {
      ...nonempty[0]!,
      sealedRemoteSequence: 1,
      sealedHeadRootSha256: sha256("nonempty"),
    };
    await expect(new MemorySessionStore().activateTenantRestoreJournalControl({
      adapterProtocol: configured[0]!.adapterProtocol,
      journalNamespaceSha256: configured[0]!.journalNamespaceSha256,
      logicalDatabaseNamespaceSha256,
      runtimeEpochSha256,
      targets: configured,
      observedHeads: nonempty,
    })).rejects.toThrow(/requires exact empty remote heads/);
  });

  it("keeps a pre-activation T1 replayable while its publication is pending", async () => {
    const nowMs = 15_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const input = requestInput("tenant-pre-activation-t1", nowMs);
    await store.setTenantAuth(input.tenantId, DEFAULT_AUTH_POLICY);
    const committed = await store.requestTenantErasure(input);
    expect(await store.getTenantRestoreJournalPublicationJob(input.tenantId, input.requestId))
      .toBeNull();

    await activate(store);
    expect(await store.replayTenantErasure({
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
    })).toEqual(committed);
    expect(await store.requestTenantErasure(input)).toEqual(committed);
    expect(await store.getTenantErasureRequest(input.tenantId, input.requestId)).toEqual(committed);
    expect(await store.getTenantRestoreJournalPublicationJob(input.tenantId, input.requestId))
      .toBeNull();

    const [credentialClaim] = await store.claimTenantCredentialRevocations({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "pre-activation-publication-pending",
    });
    expect(credentialClaim).toBeDefined();
    await expect(store.revokeTenantCredentialMaterial(
      revocationAuthorization(credentialClaim!),
    )).rejects.toBeInstanceOf(TenantErasureIntegrityError);

    expect(await store.materializeTenantRestoreJournalPublicationJobs({ limit: 1 })).toBe(1);
    expect(await store.getTenantRestoreJournalPublicationJob(input.tenantId, input.requestId))
      .toMatchObject({ phase: "queued", targetCount: 1, targetAckCount: 0 });
  });

  it("publishes T1 atomically, rolls all admission state back on serialization failure", async () => {
    const nowMs = 20_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    await activate(store);
    await store.setTenantAuth("tenant-atomic-rollback", DEFAULT_AUTH_POLICY);
    store.tenantRestoreJournalPublicationTargets = new FailOnceMap();
    const input = requestInput("tenant-atomic-rollback", nowMs);

    await expect(store.requestTenantErasure(input)).rejects.toThrow(
      "injected map serialization failure",
    );
    expect(store.tenantErasureAdmissions.size).toBe(0);
    expect(store.tenantCredentialRevocationFences.size).toBe(0);
    expect(store.tenantCredentialRevocationJobs.size).toBe(0);
    expect(store.tenantRestoreJournalPublicationJobs.size).toBe(0);
    expect(store.tenantRestoreJournalPublicationTargets.size).toBe(0);
    expect(await store.getTenantRuntimeState(input.tenantId)).toEqual({
      tenantId: input.tenantId,
      state: "active",
      generation: 0,
    });
  });

  it("rejects a T1 admission before publication when journal/runtime control is torn", async () => {
    const nowMs = 25_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    await activate(store);
    const tenantId = "tenant-runtime-control-torn";
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    store.tenantRestoreRuntimeControls.clear();
    const input = requestInput(tenantId, nowMs);

    await expect(store.requestTenantErasure(input)).rejects.toBeInstanceOf(
      TenantErasureIntegrityError,
    );
    expect(store.tenantErasureAdmissions.size).toBe(0);
    expect(store.tenantCredentialRevocationFences.size).toBe(0);
    expect(store.tenantCredentialRevocationJobs.size).toBe(0);
    expect(store.tenantRestoreJournalPublicationJobs.size).toBe(0);
    expect(store.tenantRestoreJournalPublicationTargets.size).toBe(0);
    expect(store.subjectLifecycles.get(JSON.stringify([tenantId, "tenant", tenantId])))
      .toBeUndefined();
  });

  it("enforces lease ABA, all-target ACKs and publication before T3a", async () => {
    let nowMs = 30_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const { configured, logicalDatabaseNamespaceSha256 } = await activate(store, 2);
    const input = requestInput("tenant-publication", nowMs);
    await store.setTenantAuth(input.tenantId, DEFAULT_AUTH_POLICY);
    const preT1ArtifactId = "artifact-before-tenant-t1";
    const preT1LeaseToken = "lease-before-tenant-t1";
    store.userDataExportDownloadLeases.set(
      JSON.stringify([preT1ArtifactId, preT1LeaseToken]),
      {
        artifactId: preT1ArtifactId,
        requestId: "request-before-tenant-t1",
        tenantId: input.tenantId,
        userId: "user-before-tenant-t1",
        leaseToken: preT1LeaseToken,
        leaseUntilMs: nowMs + 10_000,
        createdAtMs: nowMs,
      },
    );
    await store.requestTenantErasure(input);
    expect(await store.renewUserDataExportDownload(
      preT1ArtifactId,
      preT1LeaseToken,
      1_000,
    )).toBe(false);
    expect(await store.getTenantRestoreJournalPublicationJob(input.tenantId, input.requestId))
      .toMatchObject({ phase: "queued", targetCount: 2, targetAckCount: 0 });

    const [firstClaim] = await store.claimTenantRestoreJournalPublications({
      limit: 10,
      leaseMs: 10,
      claimToken: "publication-attempt-one",
    });
    expect(firstClaim).toBeDefined();
    nowMs += 11;
    const [secondClaim] = await store.claimTenantRestoreJournalPublications({
      limit: 10,
      leaseMs: 1_000,
      claimToken: "publication-attempt-two",
    });
    expect(secondClaim).toMatchObject({ requestId: input.requestId, claimAttempt: 2 });
    expect(await store.renewTenantRestoreJournalPublication(
      publicationAuthorization(firstClaim!),
      { leaseMs: 100 },
    )).toBe(false);
    expect(await store.getTenantRestoreJournalPublicationRecord(
      publicationAuthorization(firstClaim!),
      0,
    )).toBeNull();

    const [t3aClaim] = await store.claimTenantCredentialRevocations({
      limit: 10,
      leaseMs: 1_000,
      claimToken: "t3a-before-publication",
    });
    expect(t3aClaim).toBeDefined();
    await expect(store.revokeTenantCredentialMaterial(revocationAuthorization(t3aClaim!)))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);

    const authorization = publicationAuthorization(secondClaim!);
    for (const target of configured) {
      const pending = await store.getTenantRestoreJournalPublicationRecord(
        authorization,
        target.targetOrdinal,
      );
      expect(pending).not.toBeNull();
      const result = appendResult(
        target,
        logicalDatabaseNamespaceSha256,
        pending!.record,
      );
      const ack = await store.recordTenantRestoreJournalPublicationTargetAck(
        authorization,
        result,
      );
      expect(ack).toMatchObject({
        targetOrdinal: target.targetOrdinal,
        failureDomainSha256: target.failureDomainSha256,
        remoteSequence: 1,
      });
      expect(await store.recordTenantRestoreJournalPublicationTargetAck(
        authorization,
        { ...result, replayed: true },
      )).toEqual(ack);
    }
    const receipt = await store.sealTenantRestoreJournalPublication(authorization);
    expect(receipt).toMatchObject({
      targetAckCount: 2,
      remoteCommitCount: 2,
      restoreFencePublicationComplete: true,
      restoreFenceReplayComplete: false,
      physicalReplayComplete: false,
      allDomainsComplete: false,
      contentPurgeExecuted: false,
    });
    expect(await store.revokeTenantCredentialMaterial(revocationAuthorization(t3aClaim!)))
      .toMatchObject({ requestId: input.requestId });
    expect((await store.getTenantRestoreRuntimeControl()).controlGeneration).toBe(3);
    expect(await store.getTenantRestoreRuntimeHeads()).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetOrdinal: 0, sealedRemoteSequence: 1 }),
      expect.objectContaining({ targetOrdinal: 1, sealedRemoteSequence: 1 }),
    ]));
  });

  it("retries three reverse-order ACKs until the durable runtime head catches up", async () => {
    const nowMs = 34_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const { configured, logicalDatabaseNamespaceSha256 } = await activate(store);
    const inputs = [
      requestInput("tenant-reverse-ack-one", nowMs),
      requestInput("tenant-reverse-ack-two", nowMs),
      requestInput("tenant-reverse-ack-three", nowMs),
    ];
    for (const input of inputs) {
      await store.setTenantAuth(input.tenantId, DEFAULT_AUTH_POLICY);
      await store.requestTenantErasure(input);
    }
    const claims = await store.claimTenantRestoreJournalPublications({
      limit: 3,
      leaseMs: 10_000,
      claimToken: "three-job-reverse-ack",
    });
    expect(claims).toHaveLength(3);
    const authorizations = new Map(claims.map((claim) => [
      claim.requestId,
      publicationAuthorization(claim),
    ]));
    const records: TenantRestoreJournalRecord[] = [];
    for (const input of inputs) {
      const pending = await store.getTenantRestoreJournalPublicationRecord(
        authorizations.get(input.requestId)!,
        0,
      );
      expect(pending).not.toBeNull();
      records.push(pending!.record);
    }
    const first = appendResult(
      configured[0]!,
      logicalDatabaseNamespaceSha256,
      records[0]!,
    );
    const second = appendResult(
      configured[0]!,
      logicalDatabaseNamespaceSha256,
      records[1]!,
      2,
      first.headRootSha256,
    );
    const third = appendResult(
      configured[0]!,
      logicalDatabaseNamespaceSha256,
      records[2]!,
      3,
      second.headRootSha256,
    );
    const firstAuth = authorizations.get(inputs[0]!.requestId)!;
    const secondAuth = authorizations.get(inputs[1]!.requestId)!;
    const thirdAuth = authorizations.get(inputs[2]!.requestId)!;

    const wrongFirstRoot = appendResult(
      configured[0]!,
      logicalDatabaseNamespaceSha256,
      records[0]!,
      1,
      "f".repeat(64),
    );
    await expect(store.recordTenantRestoreJournalPublicationTargetAck(firstAuth, wrongFirstRoot))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.recordTenantRestoreJournalPublicationTargetAck(thirdAuth, third))
      .rejects.toBeInstanceOf(TenantRestoreJournalPublicationDependencyPendingError);
    await expect(store.recordTenantRestoreJournalPublicationTargetAck(secondAuth, second))
      .rejects.toBeInstanceOf(TenantRestoreJournalPublicationDependencyPendingError);
    expect(await store.getTenantRestoreRuntimeHeads()).toMatchObject([
      { sealedRemoteSequence: 0 },
    ]);
    expect(store.tenantRestoreJournalPublicationTargetAcks.size).toBe(0);

    await expect(store.recordTenantRestoreJournalPublicationTargetAck(firstAuth, first))
      .resolves.toMatchObject({ remoteSequence: 1 });
    await expect(store.recordTenantRestoreJournalPublicationTargetAck(thirdAuth, third))
      .rejects.toBeInstanceOf(TenantRestoreJournalPublicationDependencyPendingError);
    await expect(store.recordTenantRestoreJournalPublicationTargetAck(secondAuth, second))
      .resolves.toMatchObject({ remoteSequence: 2 });
    await expect(store.recordTenantRestoreJournalPublicationTargetAck(thirdAuth, third))
      .resolves.toMatchObject({ remoteSequence: 3 });
    expect(await store.getTenantRestoreRuntimeHeads()).toMatchObject([
      { sealedRemoteSequence: 3, sealedHeadRootSha256: third.headRootSha256 },
    ]);
    expect(store.tenantRestoreJournalPublicationTargetAcks.size).toBe(3);
    for (const input of inputs) {
      await expect(store.sealTenantRestoreJournalPublication(
        authorizations.get(input.requestId)!,
      )).resolves.toMatchObject({ restoreFencePublicationComplete: true });
    }
  });

  it("accepts exact ACK/seal response-loss replay only with an intact runtime projection", async () => {
    const nowMs = 35_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const { configured, logicalDatabaseNamespaceSha256 } = await activate(store);
    const input = requestInput("tenant-runtime-projection-replay", nowMs);
    await store.setTenantAuth(input.tenantId, DEFAULT_AUTH_POLICY);
    await store.requestTenantErasure(input);
    const [claim] = await store.claimTenantRestoreJournalPublications({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "runtime-projection-replay",
    });
    const authorization = publicationAuthorization(claim!);
    const pending = await store.getTenantRestoreJournalPublicationRecord(authorization, 0);
    const result = appendResult(
      configured[0]!,
      logicalDatabaseNamespaceSha256,
      pending!.record,
    );
    const ack = await store.recordTenantRestoreJournalPublicationTargetAck(
      authorization,
      result,
    );
    expect(ack).not.toBeNull();

    const controlSnapshot = new Map(store.tenantRestoreRuntimeControls);
    const headSnapshot = new Map(store.tenantRestoreRuntimeHeads);
    const eventSnapshot = new Map(store.tenantRestoreRuntimeControlEvents);
    const knownSnapshot = new Map(store.tenantRestoreRuntimeKnownEntries);
    const restoreRuntimeProjection = (): void => {
      restoreMap(store.tenantRestoreRuntimeControls, controlSnapshot);
      restoreMap(store.tenantRestoreRuntimeHeads, headSnapshot);
      restoreMap(store.tenantRestoreRuntimeControlEvents, eventSnapshot);
      restoreMap(store.tenantRestoreRuntimeKnownEntries, knownSnapshot);
    };
    const exactAckReplay = () => store.recordTenantRestoreJournalPublicationTargetAck(
      authorization,
      { ...result, replayed: true },
    );

    store.tenantRestoreRuntimeKnownEntries.clear();
    await expect(exactAckReplay()).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    restoreRuntimeProjection();

    store.tenantRestoreRuntimeControlEvents.delete(2);
    await expect(exactAckReplay()).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    restoreRuntimeProjection();

    store.tenantRestoreRuntimeHeads.set(0, {
      ...store.tenantRestoreRuntimeHeads.get(0)!,
      sealedRemoteSequence: 0,
      sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
    });
    await expect(exactAckReplay()).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    restoreRuntimeProjection();

    store.tenantRestoreRuntimeControls.set(1, structuredClone(
      store.tenantRestoreRuntimeControlEvents.get(1)!,
    ));
    await expect(exactAckReplay()).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    restoreRuntimeProjection();
    await expect(exactAckReplay()).resolves.toEqual(ack);

    store.tenantRestoreRuntimeKnownEntries.clear();
    await expect(store.sealTenantRestoreJournalPublication(authorization))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(store.tenantRestoreJournalPublicationReceipts.size).toBe(0);
    expect(store.tenantRestoreJournalPublicationJobs.get(input.requestId)).toMatchObject({
      phase: "queued",
    });
    restoreRuntimeProjection();
    const receipt = await store.sealTenantRestoreJournalPublication(authorization);
    expect(receipt).not.toBeNull();
    store.tenantRestoreRuntimeKnownEntries.clear();
    await expect(store.sealTenantRestoreJournalPublication(authorization))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    restoreRuntimeProjection();
    await expect(store.sealTenantRestoreJournalPublication(authorization)).resolves.toEqual(receipt);
  });

  it("uses only the exact active restore replay entry for an ACKed unsealed publication", async () => {
    const nowMs = 37_500;
    const store = new MemorySessionStore({ now: () => nowMs });
    const { configured, logicalDatabaseNamespaceSha256 } = await activate(store);
    const journal = await store.getTenantRestoreJournalControl();
    if (journal.controlGeneration !== 1) throw new Error("expected active restore journal");
    const input = requestInput("tenant-acked-before-restore", nowMs);
    await store.setTenantAuth(input.tenantId, DEFAULT_AUTH_POLICY);
    await store.requestTenantErasure(input);
    const [claim] = await store.claimTenantRestoreJournalPublications({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "acked-before-restore",
    });
    const authorization = publicationAuthorization(claim!);
    const pending = await store.getTenantRestoreJournalPublicationRecord(authorization, 0);
    const result = appendResult(
      configured[0]!,
      logicalDatabaseNamespaceSha256,
      pending!.record,
    );
    const ack = await store.recordTenantRestoreJournalPublicationTargetAck(
      authorization,
      result,
    );
    expect(ack).not.toBeNull();
    expect(await store.getTenantRestoreJournalPublicationJob(input.tenantId, input.requestId))
      .toMatchObject({ phase: "queued", targetAckCount: 1 });
    expect(store.tenantRestoreJournalPublicationReceipts.has(input.requestId)).toBe(false);

    const runId = restoreRunId();
    const restoredEpoch = tenantRestoreRuntimeEpochSha256("acked-before-seal-restore");
    const sealedTargets: TenantRestoreReplaySealedTarget[] = [{
      ...configured[0]!,
      logicalDatabaseNamespaceSha256,
      sealedRemoteSequence: result.remoteSequence,
      sealedHeadRootSha256: result.headRootSha256,
    }];
    await store.prepareTenantRestoreReplay({
      restoreRunId: runId,
      sourceBackupSha256: sha256("acked-before-seal-backup"),
      runtimeEpochSha256: restoredEpoch,
      controlEvidenceSha256: journal.evidenceSha256,
      sealedTargets,
    });
    await expect(store.recordTenantRestoreReplayFence({
      restoreRunId: runId,
      targetOrdinal: 0,
      remoteEntry: remoteEntry(result),
    })).resolves.toMatchObject({ recordSha256: result.record.recordSha256 });
    await expect(store.sealTenantRestoreReplay(runId)).resolves.toMatchObject({
      restoreFenceReplayComplete: true,
    });
    const beforeActivation = await store.getTenantRestoreRuntimeControl();
    if (beforeActivation.state !== "active") throw new Error("expected active primary runtime");
    await expect(store.activateTenantRestoreRuntime({
      restoreRunId: runId,
      expectedControlGeneration: beforeActivation.controlGeneration,
    })).resolves.toMatchObject({
      lineageKind: "restore",
      runtimeEpochSha256: restoredEpoch,
    });

    const replayKey = JSON.stringify([runId, 1]);
    const replayed = structuredClone(store.tenantRestoreReplayEntries.get(replayKey));
    if (!replayed) throw new Error("expected restored replay entry");
    const exactAckReplay = () => store.recordTenantRestoreJournalPublicationTargetAck(
      authorization,
      { ...result, replayed: true },
    );

    store.tenantRestoreReplayEntries.set(replayKey, {
      ...replayed,
      recordSha256: sha256("damaged-restored-publication-record"),
    });
    await expect(exactAckReplay()).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.sealTenantRestoreJournalPublication(authorization))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);

    store.tenantRestoreReplayEntries.set(replayKey, replayed);
    store.tenantRestoreReplayEntries.delete(replayKey);
    await expect(exactAckReplay()).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.sealTenantRestoreJournalPublication(authorization))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);

    store.tenantRestoreReplayEntries.set(replayKey, {
      ...replayed,
      tenantId: "tenant-cross-owner-replay",
    });
    await expect(exactAckReplay()).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.sealTenantRestoreJournalPublication(authorization))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);

    store.tenantRestoreReplayEntries.set(replayKey, replayed);
    await expect(exactAckReplay()).resolves.toEqual(ack);
    const receipt = await store.sealTenantRestoreJournalPublication(authorization);
    expect(receipt).toMatchObject({ restoreFencePublicationComplete: true });

    store.tenantRestoreReplayEntries.delete(replayKey);
    await expect(store.sealTenantRestoreJournalPublication(authorization))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
  });

  it("accepts exact startup catch-up once, rejects rollback-unknown records and old epochs", async () => {
    let nowMs = 40_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const { configured, logicalDatabaseNamespaceSha256, runtimeEpochSha256 } =
      await activate(store);
    const journal = await store.getTenantRestoreJournalControl();
    if (journal.controlGeneration !== 1) throw new Error("expected active journal control");

    const unknown = appendResult(
      configured[0]!,
      logicalDatabaseNamespaceSha256,
      standaloneRecord(logicalDatabaseNamespaceSha256, "tenant-lost-by-rollback"),
    );
    await expect(store.assertTenantRestoreRuntimeJournalEntryKnown({
      runtimeEpochSha256,
      controlEvidenceSha256: journal.evidenceSha256,
      expectedControlGeneration: 1,
      targetOrdinal: 0,
      remoteEntry: remoteEntry(unknown),
    })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect((await store.getTenantRestoreRuntimeHeads())[0]).toMatchObject({
      sealedRemoteSequence: 0,
    });

    const input = requestInput("tenant-known-at-t1", nowMs);
    await store.setTenantAuth(input.tenantId, DEFAULT_AUTH_POLICY);
    await store.requestTenantErasure(input);
    const [claim] = await store.claimTenantRestoreJournalPublications({
      limit: 10,
      leaseMs: 1_000,
      claimToken: "startup-known-publication",
    });
    const authorization = publicationAuthorization(claim!);
    const pending = await store.getTenantRestoreJournalPublicationRecord(authorization, 0);
    const result = appendResult(
      configured[0]!,
      logicalDatabaseNamespaceSha256,
      pending!.record,
    );
    const advanced = await store.assertTenantRestoreRuntimeJournalEntryKnown({
      runtimeEpochSha256,
      controlEvidenceSha256: journal.evidenceSha256,
      expectedControlGeneration: 1,
      targetOrdinal: 0,
      remoteEntry: remoteEntry(result),
    });
    expect(advanced).toMatchObject({ controlGeneration: 2, updateKind: "journal_head_advance" });

    const secondInput = requestInput("tenant-known-at-t1-two", nowMs);
    await store.setTenantAuth(secondInput.tenantId, DEFAULT_AUTH_POLICY);
    await store.requestTenantErasure(secondInput);
    const [secondClaim] = await store.claimTenantRestoreJournalPublications({
      limit: 10,
      leaseMs: 1_000,
      claimToken: "startup-known-publication-two",
    });
    const secondAuthorization = publicationAuthorization(secondClaim!);
    const secondPending = await store.getTenantRestoreJournalPublicationRecord(
      secondAuthorization,
      0,
    );
    const secondResult = appendResult(
      configured[0]!,
      logicalDatabaseNamespaceSha256,
      secondPending!.record,
      2,
      result.headRootSha256,
    );
    const advancedAgain = await store.assertTenantRestoreRuntimeJournalEntryKnown({
      runtimeEpochSha256,
      controlEvidenceSha256: journal.evidenceSha256,
      expectedControlGeneration: 2,
      targetOrdinal: 0,
      remoteEntry: remoteEntry(secondResult),
    });
    expect(advancedAgain).toMatchObject({ controlGeneration: 3 });
    expect(await store.assertTenantRestoreRuntimeJournalEntryKnown({
      runtimeEpochSha256,
      controlEvidenceSha256: journal.evidenceSha256,
      // Entry 1's response-loss replay remains exact after entry 2 already advanced the head.
      expectedControlGeneration: 1,
      targetOrdinal: 0,
      remoteEntry: remoteEntry(result),
    })).toEqual(advancedAgain);
    expect(await store.recordTenantRestoreJournalPublicationTargetAck(
      authorization,
      result,
    )).toMatchObject({ remoteSequence: 1 });
    const heads = await store.getTenantRestoreRuntimeHeads();
    await expect(store.assertTenantRestoreRuntimeReady({
      runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("wrong-old-epoch"),
      controlEvidenceSha256: journal.evidenceSha256,
      observedHeads: heads,
    })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.assertTenantRestoreRuntimeReady({
      runtimeEpochSha256,
      controlEvidenceSha256: journal.evidenceSha256,
      observedHeads: heads,
    })).resolves.toBeUndefined();
  });

  it("replays permanent fences, retains them on abort, and supports repeated restore epochs", async () => {
    let nowMs = 50_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const { configured, logicalDatabaseNamespaceSha256, runtimeEpochSha256 } =
      await activate(store);
    const journal = await store.getTenantRestoreJournalControl();
    if (journal.controlGeneration !== 1) throw new Error("expected active journal control");
    const record = standaloneRecord(logicalDatabaseNamespaceSha256, "tenant-restored-fence");
    await store.putRetentionPolicy({
      tenantId: record.tenantId,
      policyVersion: "restore-export-policy-v1",
      policy: {
        sessionContentRetentionMs: 30 * 24 * 60 * 60 * 1_000,
        userErasureGraceMs: 7 * 24 * 60 * 60 * 1_000,
        operationalUsageRetentionMs: null,
        idempotencyReceiptRetentionMs: 24 * 60 * 60 * 1_000,
        billingFactRetentionMs: null,
        lifecycleAuditRetentionMs: null,
        exportArtifactTtlMs: 60_000,
      },
      actorKeyId: "restore-policy-admin",
      atMs: nowMs - 2,
    });
    await store.activateRetentionPolicy({
      tenantId: record.tenantId,
      policyVersion: "restore-export-policy-v1",
      expectedControlGeneration: 0,
      actorKeyId: "restore-policy-admin",
      atMs: nowMs - 1,
    });
    const exportReplayInput = {
      requestId: newUserDataExportRequestId(),
      tenantId: record.tenantId,
      userId: "restore-export-user",
      requestedByKeyId: "restore-export-admin",
      idempotencyKeySha256: userDataExportIdempotencyKeySha256("restore-export-replay"),
      requestHash: userDataExportRequestHash(record.tenantId, "restore-export-user"),
    };
    await expect(store.requestUserDataExport(exportReplayInput)).resolves.toMatchObject({
      requestId: exportReplayInput.requestId,
      status: "queued",
    });
    const result = appendResult(configured[0]!, logicalDatabaseNamespaceSha256, record);
    const sealedTargets: TenantRestoreReplaySealedTarget[] = [{
      ...configured[0]!,
      logicalDatabaseNamespaceSha256,
      sealedRemoteSequence: 1,
      sealedHeadRootSha256: result.headRootSha256,
    }];

    const abortedRunId = restoreRunId();
    await store.prepareTenantRestoreReplay({
      restoreRunId: abortedRunId,
      sourceBackupSha256: sha256("aborted-backup"),
      runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("aborted-epoch"),
      controlEvidenceSha256: journal.evidenceSha256,
      sealedTargets,
    });
    const [abortedTargetKey, durableAbortedTarget] = [
      ...store.tenantRestoreReplaySealedTargets.entries(),
    ][0]!;
    store.tenantRestoreReplaySealedTargets.set(abortedTargetKey, {
      ...durableAbortedTarget,
      adapterProtocol: "restore-journal-fake-v2",
    });
    await expect(store.getTenantRestoreReplayRun(abortedRunId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    store.tenantRestoreReplaySealedTargets.set(abortedTargetKey, durableAbortedTarget);
    await expect(store.prepareTenantRestoreReplay({
      restoreRunId: abortedRunId,
      sourceBackupSha256: sha256("aborted-backup"),
      runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("aborted-epoch"),
      controlEvidenceSha256: journal.evidenceSha256,
      sealedTargets: [{
        ...sealedTargets[0]!,
        logicalDatabaseNamespaceSha256: sha256("wrong-logical-database"),
      }],
    })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    const restoredLeaseArtifactId = "artifact-before-restored-fence";
    const restoredLeaseToken = "lease-before-restored-fence";
    store.userDataExportDownloadLeases.set(
      JSON.stringify([restoredLeaseArtifactId, restoredLeaseToken]),
      {
        artifactId: restoredLeaseArtifactId,
        requestId: "request-before-restored-fence",
        tenantId: record.tenantId,
        userId: "user-before-restored-fence",
        leaseToken: restoredLeaseToken,
        leaseUntilMs: nowMs + 10_000,
        createdAtMs: nowMs,
      },
    );
    const abortedEntry = await store.recordTenantRestoreReplayFence({
      restoreRunId: abortedRunId,
      targetOrdinal: 0,
      remoteEntry: remoteEntry(result),
    });
    expect(abortedEntry).toMatchObject({ fenceDisposition: "installed" });
    expect(await store.abortTenantRestoreReplay(abortedRunId)).toBe(true);
    await expect(store.prepareTenantRestoreReplay({
      restoreRunId: restoreRunId(),
      sourceBackupSha256: sha256("aborted-epoch-reuse"),
      runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("aborted-epoch"),
      controlEvidenceSha256: journal.evidenceSha256,
      sealedTargets,
    })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(await store.getTenantRestoreFence(record.tenantId)).toMatchObject({
      requestId: record.requestId,
      recordSha256: record.recordSha256,
    });
    expect(await store.renewUserDataExportDownload(
      restoredLeaseArtifactId,
      restoredLeaseToken,
      1_000,
    )).toBe(false);
    await expect(store.requestUserDataExport({
      ...exportReplayInput,
      requestId: newUserDataExportRequestId(),
    })).rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(store.assertTenantRestoreRuntimeReady({
      runtimeEpochSha256,
      controlEvidenceSha256: journal.evidenceSha256,
      observedHeads: sealedTargets,
    })).rejects.toBeInstanceOf(TenantErasureIntegrityError);

    const firstRunId = restoreRunId();
    const firstEpoch = tenantRestoreRuntimeEpochSha256("restored-epoch-one");
    await store.prepareTenantRestoreReplay({
      restoreRunId: firstRunId,
      sourceBackupSha256: sha256("backup-one"),
      runtimeEpochSha256: firstEpoch,
      controlEvidenceSha256: journal.evidenceSha256,
      sealedTargets,
    });
    expect(await store.recordTenantRestoreReplayFence({
      restoreRunId: firstRunId,
      targetOrdinal: 0,
      remoteEntry: remoteEntry(result),
    })).toMatchObject({ fenceDisposition: "exact_replay" });
    expect(await store.sealTenantRestoreReplay(firstRunId)).toMatchObject({
      restoreFenceReplayComplete: true,
      physicalReplayComplete: false,
      allDomainsComplete: false,
      contentPurgeExecuted: false,
    });
    const originalRun = structuredClone(store.tenantRestoreReplayRuns.get(firstRunId));
    const originalReceipt = structuredClone(store.tenantRestoreReplayReceipts.get(firstRunId));
    if (!originalRun || originalRun.phase !== "replay_sealed" || !originalReceipt) {
      throw new Error("expected sealed replay fixture");
    }
    const { receiptSha256: _receiptSha256, ...receiptBody } = originalReceipt;
    const forgedReceiptBody = {
      ...receiptBody,
      sourceBackupSha256: sha256("wrong-backup-source"),
    };
    const forgedReceipt = {
      ...forgedReceiptBody,
      receiptSha256: tenantRestoreReplayReceiptSha256(forgedReceiptBody),
    };
    store.tenantRestoreReplayReceipts.set(firstRunId, forgedReceipt);
    store.tenantRestoreReplayRuns.set(firstRunId, {
      ...originalRun,
      terminalReceiptSha256: forgedReceipt.receiptSha256,
    });
    await expect(store.getTenantRestoreReplayReceipt(firstRunId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    store.tenantRestoreReplayRuns.set(firstRunId, originalRun);
    store.tenantRestoreReplayReceipts.set(firstRunId, originalReceipt);
    const firstActivation = await store.activateTenantRestoreRuntime({
      restoreRunId: firstRunId,
      expectedControlGeneration: 1,
    });
    expect(firstActivation).toMatchObject({
      controlGeneration: 2,
      updateKind: "restore_activation",
      lineageKind: "restore",
      runtimeEpochSha256: firstEpoch,
    });
    expect(await store.assertTenantRestoreRuntimeJournalEntryKnown({
      runtimeEpochSha256: firstEpoch,
      controlEvidenceSha256: journal.evidenceSha256,
      expectedControlGeneration: 1,
      targetOrdinal: 0,
      remoteEntry: remoteEntry(result),
    })).toEqual(firstActivation);
    expect(await store.activateTenantRestoreRuntime({
      restoreRunId: firstRunId,
      expectedControlGeneration: 1,
    })).toEqual(firstActivation);

    const secondRunId = restoreRunId();
    const secondEpoch = tenantRestoreRuntimeEpochSha256("restored-epoch-two");
    await store.prepareTenantRestoreReplay({
      restoreRunId: secondRunId,
      sourceBackupSha256: sha256("backup-two"),
      runtimeEpochSha256: secondEpoch,
      controlEvidenceSha256: journal.evidenceSha256,
      sealedTargets,
    });
    await store.recordTenantRestoreReplayFence({
      restoreRunId: secondRunId,
      targetOrdinal: 0,
      remoteEntry: remoteEntry(result),
    });
    await store.sealTenantRestoreReplay(secondRunId);
    expect(await store.activateTenantRestoreRuntime({
      restoreRunId: secondRunId,
      expectedControlGeneration: 2,
    })).toMatchObject({
      controlGeneration: 3,
      runtimeEpochSha256: secondEpoch,
    });
    await expect(store.createSession(mkSession(record.tenantId, "restored-user")))
      .rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(store.createSession(mkSession("tenant-neighbor", "neighbor-user")))
      .resolves.toBeDefined();
  });

  it("rejects noncanonical records before any durable mutation", () => {
    const logicalDatabaseNamespaceSha256 =
      tenantRestoreLogicalDatabaseNamespaceSha256("strict-record-db");
    const record = standaloneRecord(logicalDatabaseNamespaceSha256, "tenant-strict-record");
    expect(() => validateTenantRestoreJournalRecord({
      ...record,
      secret: "must-never-be-accepted",
    } as TenantRestoreJournalRecord)).toThrow(/unknown or missing fields/);

    const commonRuntime = {
      singletonId: 1 as const,
      state: "active" as const,
      controlGeneration: 1,
      activatedAtDbMs: 1,
      updatedAtDbMs: 1,
      runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("hostile-runtime"),
      controlEvidenceSha256: sha256("control"),
      logicalDatabaseNamespaceSha256,
      targetCount: 1,
      targetRootSha256: sha256("targets"),
      verifiedHeadRootSha256: sha256("heads"),
      previousControlEvidenceSha256:
        EMPTY_TENANT_RESTORE_RUNTIME_CONTROL_EVIDENCE_SHA256,
    };
    expect(() => tenantRestoreRuntimeControlEvidenceSha256({
      ...commonRuntime,
      updateKind: "restore_activation",
      lineageKind: "primary",
    } as never)).toThrow(/primary.*cannot restore-activate/);
    expect(() => tenantRestoreRuntimeControlEvidenceSha256({
      ...commonRuntime,
      updateKind: "primary_activation",
      lineageKind: "restore",
      restoreRunId: restoreRunId(),
      replayReceiptSha256: sha256("receipt"),
    } as never)).toThrow(/restore.*cannot primary-activate/);
  });
});
