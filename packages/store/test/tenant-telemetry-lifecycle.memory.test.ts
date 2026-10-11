import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  SubjectDeletingError,
  TenantTelemetryLifecycleConflictError,
  TenantTelemetryLifecycleIntegrityError,
  newErasureRequestId,
  newUserDataExportRequestId,
  tenantErasureRequestHash,
  tenantTelemetryRefKeyIdSha256,
  userDataExportRequestHash,
  userErasureRequestHash,
  type RetentionPolicyDocumentV1,
} from "../src/index.js";
import { mkSession } from "./conformance.js";

const digest = (character: string) => character.repeat(64);

const retentionPolicy = (): RetentionPolicyDocumentV1 => ({
  sessionContentRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  userErasureGraceMs: 7 * 24 * 60 * 60 * 1_000,
  operationalUsageRetentionMs: null,
  idempotencyReceiptRetentionMs: 24 * 60 * 60 * 1_000,
  billingFactRetentionMs: null,
  lifecycleAuditRetentionMs: null,
  exportArtifactTtlMs: 60 * 60 * 1_000,
});

const activation = (suffix = "a") => ({
  expectedControlGeneration: 0 as const,
  targets: [
    {
      domain: "traces" as const,
      backendKind: "memory",
      adapterProtocol: "telemetry-memory-v1",
      namespaceSha256: digest(suffix === "a" ? "b" : "d"),
      failureDomainSha256: digest("e"),
    },
    {
      domain: "logs" as const,
      backendKind: "memory",
      adapterProtocol: "telemetry-memory-v1",
      namespaceSha256: digest(suffix === "a" ? "a" : "c"),
      failureDomainSha256: digest("f"),
    },
  ],
});

const artifact = (
  tenantId: string,
  overrides: Partial<Parameters<MemorySessionStore["registerTenantTelemetryArtifact"]>[0]> = {},
) => ({
  tenantId,
  expectedControlGeneration: 1 as const,
  domain: "logs" as const,
  artifactIdSha256: digest("1"),
  artifactGeneration: 1,
  ownerKind: "tenant" as const,
  ownerId: tenantId,
  ownerUserId: null,
  sourceSchema: "structured-log-batch-v1",
  sourceGeneration: 0,
  sourceHighWaterDbMs: 1_100,
  payloadSha256: digest("2"),
  manifestSha256: digest("3"),
  ...overrides,
});

describe("MemorySessionStore tenant telemetry lifecycle", () => {
  it("is dormant by default and requires an immutable 32-byte reference key for activation", async () => {
    const withoutKey = new MemorySessionStore({ now: () => 1_000 });
    await expect(withoutKey.getTenantTelemetryLifecycleControl()).resolves.toEqual({
      singletonId: 1,
      state: "inactive",
      controlGeneration: 0,
    });
    await expect(withoutKey.activateTenantTelemetryLifecycle(activation()))
      .rejects.toBeInstanceOf(TenantTelemetryLifecycleIntegrityError);
    expect(withoutKey.tenantTelemetryLifecycleTargets).toHaveLength(0);
    expect(withoutKey.tenantTelemetryLifecycleCoverages).toHaveLength(0);

    expect(() => new MemorySessionStore(
      { now: () => 1_000 },
      { tenantTelemetryRefKey: new Uint8Array(31) },
    )).toThrow(/exactly 32 bytes/);
  });

  it("atomically activates targets, legacy coverage, control and an exact-replay receipt", async () => {
    let nowMs = 1_000;
    const sourceKey = new Uint8Array(32).fill(7);
    const expectedRefKeyId = tenantTelemetryRefKeyIdSha256(sourceKey);
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: sourceKey },
    );
    sourceKey.fill(8);
    await store.createApiKey("tenant-legacy", "key-legacy", "hash-legacy");
    await store.createSession({
      ...mkSession("tenant-lifecycle-only", "user-lifecycle-only"),
      createdAtMs: 1_500,
      updatedAtMs: 1_500,
    });
    nowMs = 2_000;

    const first = await store.activateTenantTelemetryLifecycle(activation());
    expect(first.control).toMatchObject({
      state: "active",
      controlGeneration: 1,
      refKeyIdSha256: expectedRefKeyId,
      activatedAtDbMs: 2_000,
    });
    expect(first.targets.map((target) => target.domain)).toEqual(["logs", "traces"]);
    expect(first.receipt).toMatchObject({
      coverageCount: 2,
      refKeyIdSha256: expectedRefKeyId,
    });
    await expect(store.getTenantTelemetryLifecycleCoverage("tenant-legacy"))
      .resolves.toMatchObject({
        historyStatus: "legacy_history_unknown",
        coverageStartedAtDbMs: 2_000,
      });
    await expect(store.getTenantTelemetryLifecycleCoverage("tenant-lifecycle-only"))
      .resolves.toMatchObject({ historyStatus: "legacy_history_unknown" });

    await expect(store.activateTenantTelemetryLifecycle(activation())).resolves.toEqual(first);
    await expect(store.activateTenantTelemetryLifecycle(activation("other")))
      .rejects.toBeInstanceOf(TenantTelemetryLifecycleConflictError);
    await expect(Promise.all([
      store.activateTenantTelemetryLifecycle(activation()),
      store.activateTenantTelemetryLifecycle(activation()),
    ])).resolves.toEqual([first, first]);
  });

  it("rolls back every activation projection when publication fails", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: new Uint8Array(32).fill(4) },
    );
    await store.createApiKey("tenant-rollback", "key-rollback", "hash-rollback");
    nowMs = 2_000;
    const originalSet = store.tenantTelemetryLifecycleCoverages.set.bind(
      store.tenantTelemetryLifecycleCoverages,
    );
    let fail = true;
    Object.defineProperty(store.tenantTelemetryLifecycleCoverages, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof originalSet>[1]) => {
        if (fail) {
          fail = false;
          throw new Error("injected telemetry coverage publication failure");
        }
        return originalSet(key, value);
      },
    });

    await expect(store.activateTenantTelemetryLifecycle(activation()))
      .rejects.toThrow("injected telemetry coverage publication failure");
    await expect(store.getTenantTelemetryLifecycleControl()).resolves.toEqual({
      singletonId: 1,
      state: "inactive",
      controlGeneration: 0,
    });
    expect(store.tenantTelemetryLifecycleTargets).toHaveLength(0);
    expect(store.tenantTelemetryLifecycleCoverages).toHaveLength(0);
    expect(store.tenantTelemetryLifecycleActivationReceipts).toHaveLength(0);
  });

  it("creates complete coverage in the same boundary as a post-cutover tenant", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: new Uint8Array(32).fill(5) },
    );
    await store.activateTenantTelemetryLifecycle(activation());
    nowMs = 1_100;
    await store.createApiKey("tenant-new", "key-new", "hash-new");
    const coverage = await store.getTenantTelemetryLifecycleCoverage("tenant-new");
    expect(coverage).toMatchObject({
      tenantId: "tenant-new",
      historyStatus: "complete_since_creation",
      coverageStartedAtDbMs: 1_100,
    });
    await expect(store.registerTenantTelemetryCoverage({
      tenantId: "tenant-new",
      expectedControlGeneration: 1,
      historyStatus: "complete_since_creation",
    })).resolves.toEqual(coverage);

    const originalSet = store.tenantTelemetryLifecycleCoverages.set.bind(
      store.tenantTelemetryLifecycleCoverages,
    );
    let fail = true;
    Object.defineProperty(store.tenantTelemetryLifecycleCoverages, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof originalSet>[1]) => {
        if (fail) {
          fail = false;
          throw new Error("injected tenant coverage failure");
        }
        return originalSet(key, value);
      },
    });
    nowMs = 1_200;
    await expect(store.createApiKey("tenant-failed", "key-failed", "hash-failed"))
      .rejects.toThrow("injected tenant coverage failure");
    await expect(store.getTenant("tenant-failed")).resolves.toBeNull();
    await expect(store.resolveApiKey("hash-failed")).resolves.toBeNull();
    expect(store.tenantTelemetryLifecycleCoverages.has("tenant-failed")).toBe(false);
  });

  it("keeps dormant T1 subject-free and backfills its exact proof during activation", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: new Uint8Array(32).fill(13) },
    );
    const tenantId = "tenant-telemetry-preactivation-t1";
    await store.createApiKey(tenantId, "key-preactivation", "hash-preactivation");
    nowMs = 1_100;
    const input = {
      requestId: newErasureRequestId(),
      tenantId,
      requestedByKeyId: "telemetry-subject-test",
      idempotencyKey: "telemetry-preactivation-subject",
      requestHash: tenantErasureRequestHash(tenantId),
      atMs: nowMs,
    };
    const admission = await store.requestTenantErasure(input);
    await expect(store.getTenantTelemetryLifecycleSubject(tenantId, admission.requestId))
      .resolves.toBeNull();
    expect(store.tenantTelemetryLifecycleSubjects).toHaveLength(0);

    nowMs = 1_200;
    const activated = await store.activateTenantTelemetryLifecycle(activation());
    const subject = await store.getTenantTelemetryLifecycleSubject(tenantId, admission.requestId);
    expect(subject).toMatchObject({
      requestId: admission.requestId,
      tenantId,
      subjectGeneration: admission.generation,
      t1FenceSha256: store.tenantCredentialRevocationFences.get(tenantId)?.evidenceSha256,
      targetRootSha256: activated.control.targetRootSha256,
    });
    await expect(store.getTenantTelemetryLifecycleSubject(
      "other-tenant",
      admission.requestId,
    )).resolves.toBeNull();
    await expect(store.requestTenantErasure(input)).resolves.toEqual(admission);
  });

  it("publishes active T1 subject atomically and fails closed on missing evidence", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: new Uint8Array(32).fill(14) },
    );
    await store.activateTenantTelemetryLifecycle(activation());
    nowMs = 1_100;
    const tenantId = "tenant-telemetry-active-t1";
    await store.createApiKey(tenantId, "key-active-t1", "hash-active-t1");
    const inputs = ["a", "b"].map((suffix) => ({
      requestId: newErasureRequestId(),
      tenantId,
      requestedByKeyId: "telemetry-subject-test",
      idempotencyKey: `telemetry-active-subject-${suffix}`,
      requestHash: tenantErasureRequestHash(tenantId),
      atMs: nowMs,
    }));
    const results = await Promise.all(inputs.map((input) => store.requestTenantErasure(input)));
    expect(new Set(results.map((result) => result.requestId))).toHaveLength(1);
    const requestId = results[0]!.requestId;
    await expect(store.getTenantTelemetryLifecycleSubject(tenantId, requestId))
      .resolves.toMatchObject({ requestId, tenantId });
    expect(store.tenantTelemetryLifecycleSubjects).toHaveLength(1);

    store.tenantTelemetryLifecycleSubjects.delete(requestId);
    await expect(store.getTenantTelemetryLifecycleSubject(tenantId, requestId))
      .rejects.toBeInstanceOf(TenantTelemetryLifecycleIntegrityError);
    await expect(store.getTenantTelemetryLifecycleControl())
      .rejects.toBeInstanceOf(TenantTelemetryLifecycleIntegrityError);
  });

  it("rolls back every T1 projection when active subject publication fails", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: new Uint8Array(32).fill(15) },
    );
    await store.activateTenantTelemetryLifecycle(activation());
    nowMs = 1_100;
    const tenantId = "tenant-telemetry-subject-rollback";
    await store.createApiKey(tenantId, "key-subject-rollback", "hash-subject-rollback");
    const input = {
      requestId: newErasureRequestId(),
      tenantId,
      requestedByKeyId: "telemetry-subject-test",
      idempotencyKey: "telemetry-subject-rollback",
      requestHash: tenantErasureRequestHash(tenantId),
      atMs: nowMs,
    };
    const originalSet = store.tenantTelemetryLifecycleSubjects.set.bind(
      store.tenantTelemetryLifecycleSubjects,
    );
    let fail = true;
    Object.defineProperty(store.tenantTelemetryLifecycleSubjects, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof originalSet>[1]) => {
        if (fail) {
          fail = false;
          throw new Error("injected telemetry subject publication failure");
        }
        return originalSet(key, value);
      },
    });

    await expect(store.requestTenantErasure(input))
      .rejects.toThrow("injected telemetry subject publication failure");
    await expect(store.getTenantErasureRequest(tenantId, input.requestId)).resolves.toBeNull();
    await expect(store.getTenantTelemetryLifecycleSubject(tenantId, input.requestId))
      .resolves.toBeNull();
    expect(store.tenantCredentialRevocationFences.has(tenantId)).toBe(false);
    await expect(store.requestTenantErasure(input)).resolves.toMatchObject({
      requestId: input.requestId,
    });
  });

  it("covers first-tenant governance writers and preserves coverage through policy/export writes", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: new Uint8Array(32).fill(12) },
    );
    await store.activateTenantTelemetryLifecycle(activation());

    nowMs = 1_100;
    const policy = await store.putRetentionPolicy({
      tenantId: "tenant-policy-first",
      policyVersion: "policy-v1",
      policy: retentionPolicy(),
      actorKeyId: "policy-admin",
      atMs: nowMs,
    });
    await expect(store.getTenantTelemetryLifecycleCoverage("tenant-policy-first"))
      .resolves.toMatchObject({
        historyStatus: "complete_since_creation",
        coverageStartedAtDbMs: nowMs,
      });
    nowMs += 1;
    await store.activateRetentionPolicy({
      tenantId: "tenant-policy-first",
      policyVersion: policy.policyVersion,
      expectedControlGeneration: 0,
      actorKeyId: "policy-admin",
      atMs: nowMs,
    });
    await store.requestUserDataExport({
      requestId: newUserDataExportRequestId(),
      tenantId: "tenant-policy-first",
      userId: "user-export",
      requestedByKeyId: "export-admin",
      idempotencyKeySha256: digest("d"),
      requestHash: userDataExportRequestHash("tenant-policy-first", "user-export"),
    });
    await expect(store.getTenantTelemetryLifecycleCoverage("tenant-policy-first"))
      .resolves.toMatchObject({ coverageStartedAtDbMs: 1_100 });

    nowMs = 1_200;
    await store.setLegalHold({
      tenantId: "tenant-hold-first",
      holdId: "hold_telemetry_first",
      subjectKind: "tenant",
      subjectId: "tenant-hold-first",
      reasonCode: "litigation",
      expectedControlGeneration: 0,
      actorKeyId: "hold-admin",
      atMs: nowMs,
    });
    await expect(store.getTenantTelemetryLifecycleCoverage("tenant-hold-first"))
      .resolves.toMatchObject({
        historyStatus: "complete_since_creation",
        coverageStartedAtDbMs: nowMs,
      });

    nowMs = 1_300;
    await store.requestUserErasure({
      requestId: newErasureRequestId(),
      tenantId: "tenant-erasure-first",
      userId: "user-erasure-first",
      requestedByKeyId: "erasure-admin",
      idempotencyKey: "telemetry-erasure-first",
      requestHash: userErasureRequestHash(
        "tenant-erasure-first",
        "user-erasure-first",
      ),
      atMs: nowMs,
    });
    await expect(store.getTenantTelemetryLifecycleCoverage("tenant-erasure-first"))
      .resolves.toMatchObject({
        historyStatus: "complete_since_creation",
        coverageStartedAtDbMs: nowMs,
      });
  });

  it("never repairs a pre-existing active tenant's missing coverage as complete", async () => {
    const store = new MemorySessionStore(
      { now: () => 1_000 },
      { tenantTelemetryRefKey: new Uint8Array(32).fill(6) },
    );
    await store.activateTenantTelemetryLifecycle(activation());
    await store.createApiKey("tenant-corrupt", "key-corrupt", "hash-corrupt");
    store.tenantTelemetryLifecycleCoverages.delete("tenant-corrupt");

    await expect(store.registerTenantTelemetryCoverage({
      tenantId: "tenant-corrupt",
      expectedControlGeneration: 1,
      historyStatus: "complete_since_creation",
    })).rejects.toBeInstanceOf(TenantTelemetryLifecycleIntegrityError);
    await expect(store.createApiKey("tenant-corrupt", "key-next", "hash-next"))
      .rejects.toBeInstanceOf(TenantTelemetryLifecycleIntegrityError);
    expect(store.tenantTelemetryLifecycleCoverages.has("tenant-corrupt")).toBe(false);
  });

  it("publishes immutable artifact inventory with exact replay and tenant isolation", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: new Uint8Array(32).fill(9) },
    );
    await store.activateTenantTelemetryLifecycle(activation());
    nowMs = 1_100;
    await store.createApiKey("tenant-a", "key-a", "hash-a");
    await store.createApiKey("tenant-b", "key-b", "hash-b");

    const input = artifact("tenant-a");
    const [first, replay] = await Promise.all([
      store.registerTenantTelemetryArtifact(input),
      store.registerTenantTelemetryArtifact(input),
    ]);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      tenantId: "tenant-a",
      ownerKind: "tenant",
      historyStatus: "complete_since_creation",
      retentionClass: "telemetry_policy_unconfigured",
      retentionPolicyControlGeneration: 0,
      retentionPolicySha256: null,
      disposeAfterDbMs: null,
      restoreControlGeneration: 0,
      restoreLineageKind: "inactive",
      restoreUpdatedAtDbMs: 0,
      runtimeEpochSha256: null,
    });
    await expect(store.getTenantTelemetryArtifact(
      "tenant-a",
      "logs",
      input.artifactIdSha256,
      1,
    )).resolves.toEqual(first);
    await expect(store.getTenantTelemetryArtifact(
      "tenant-b",
      "logs",
      input.artifactIdSha256,
      1,
    )).resolves.toBeNull();
    await expect(store.registerTenantTelemetryArtifact({
      ...input,
      payloadSha256: digest("4"),
    })).rejects.toBeInstanceOf(TenantTelemetryLifecycleConflictError);

    await expect(store.registerTenantTelemetryArtifact(artifact("tenant-b")))
      .rejects.toBeInstanceOf(TenantTelemetryLifecycleConflictError);
    const neighborInput = artifact("tenant-b", { artifactIdSha256: digest("8") });
    const neighbor = await store.registerTenantTelemetryArtifact(neighborInput);
    expect(neighbor.tenantRefSha256).not.toBe(first.tenantRefSha256);
    expect(neighbor.inventorySha256).not.toBe(first.inventorySha256);
    await expect(store.getTenantTelemetryArtifact(
      "tenant-a",
      neighborInput.domain,
      neighborInput.artifactIdSha256,
      neighborInput.artifactGeneration,
    )).resolves.toBeNull();
  });

  it("rejects cross-tenant session ownership and rolls back failed inventory publication", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: new Uint8Array(32).fill(10) },
    );
    await store.activateTenantTelemetryLifecycle(activation());
    nowMs = 1_100;
    await store.createApiKey("tenant-session", "key-session", "hash-session");
    await store.createApiKey("tenant-other", "key-other", "hash-other");
    const session = mkSession("tenant-session", "user-session");
    await store.createSession(session);

    const sessionInput = artifact("tenant-session", {
      artifactIdSha256: digest("5"),
      ownerKind: "session",
      ownerId: session.id,
      ownerUserId: session.userId,
    });
    await expect(store.registerTenantTelemetryArtifact(sessionInput)).resolves.toMatchObject({
      ownerKind: "session",
    });
    await expect(store.registerTenantTelemetryArtifact(artifact("tenant-other", {
      artifactIdSha256: digest("6"),
      ownerKind: "session",
      ownerId: session.id,
      ownerUserId: session.userId,
    }))).rejects.toBeInstanceOf(TenantTelemetryLifecycleConflictError);

    const originalSet = store.tenantTelemetryArtifactInventories.set.bind(
      store.tenantTelemetryArtifactInventories,
    );
    let fail = true;
    Object.defineProperty(store.tenantTelemetryArtifactInventories, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof originalSet>[1]) => {
        if (fail) {
          fail = false;
          throw new Error("injected telemetry inventory failure");
        }
        return originalSet(key, value);
      },
    });
    const failed = artifact("tenant-session", { artifactIdSha256: digest("7") });
    await expect(store.registerTenantTelemetryArtifact(failed))
      .rejects.toThrow("injected telemetry inventory failure");
    await expect(store.getTenantTelemetryArtifact(
      failed.tenantId,
      failed.domain,
      failed.artifactIdSha256,
      failed.artifactGeneration,
    )).resolves.toBeNull();
  });

  it("allows exact artifact replay but rejects new gated-user or deleted-session inventory", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantTelemetryRefKey: new Uint8Array(32).fill(11) },
    );
    await store.activateTenantTelemetryLifecycle(activation());
    nowMs = 1_100;
    const gated = mkSession("tenant-gated-owner", "user-gated-owner");
    const deleted = mkSession("tenant-deleted-owner", "user-deleted-owner");
    await store.createSession(gated);
    await store.createSession(deleted);

    const gatedInput = artifact(gated.tenantId, {
      artifactIdSha256: digest("9"),
      ownerKind: "user",
      ownerId: gated.userId,
      ownerUserId: gated.userId,
    });
    const gatedRecord = await store.registerTenantTelemetryArtifact(gatedInput);
    nowMs = 1_200;
    await store.requestUserErasure({
      requestId: newErasureRequestId(),
      tenantId: gated.tenantId,
      userId: gated.userId,
      requestedByKeyId: "admin-key",
      idempotencyKey: "telemetry-gated-owner",
      requestHash: userErasureRequestHash(gated.tenantId, gated.userId),
      atMs: nowMs,
    });
    await expect(store.registerTenantTelemetryArtifact(gatedInput)).resolves.toEqual(gatedRecord);
    await expect(store.registerTenantTelemetryArtifact({
      ...gatedInput,
      artifactIdSha256: digest("a"),
    })).rejects.toBeInstanceOf(SubjectDeletingError);

    const deletedInput = artifact(deleted.tenantId, {
      artifactIdSha256: digest("b"),
      ownerKind: "session",
      ownerId: deleted.id,
      ownerUserId: deleted.userId,
    });
    const deletedRecord = await store.registerTenantTelemetryArtifact(deletedInput);
    store.deleted.set(deleted.id, { deletedAtMs: nowMs, deletionGeneration: 1 });
    await expect(store.registerTenantTelemetryArtifact(deletedInput)).resolves.toEqual(deletedRecord);
    await expect(store.registerTenantTelemetryArtifact({
      ...deletedInput,
      artifactIdSha256: digest("c"),
    })).rejects.toBeInstanceOf(TenantTelemetryLifecycleConflictError);
  });
});
