import type { AgentDefinition, ProviderConfig } from "@agent-service/protocol";
import { DEFAULT_AUTH_POLICY } from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import {
  ErasureIdempotencyMismatchError,
  MemorySessionStore,
  SubjectDeletingError,
  TenantErasureConflictError,
  TenantErasureIntegrityError,
  TenantErasureTargetNotFoundError,
  newErasureRequestId,
  newLegalHoldId,
  subjectLifecycleKey,
  tenantCredentialRevocationFenceSha256,
  tenantErasureRequestHash,
  userErasureRequestHash,
  type ErasureJobAuthorization,
  type ErasureJobClaim,
  type ErasureWriteAuthorization,
  type RetentionPolicyDocumentV1,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const NOW = 1_900_000_000_000;

function retentionPolicy(seed = 0): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: 10_000 + seed,
    userErasureGraceMs: 20_000 + seed,
    operationalUsageRetentionMs: 30_000 + seed,
    idempotencyReceiptRetentionMs: 40_000 + seed,
    billingFactRetentionMs: null,
    lifecycleAuditRetentionMs: null,
    exportArtifactTtlMs: 50_000 + seed,
  };
}

function requestInput(tenantId: string, idempotencyKey = "tenant-erase-once") {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: NOW,
  };
}

function userRequestInput(tenantId: string, userId: string, atMs: number) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    userId,
    requestedByKeyId: "tenant-admin",
    idempotencyKey: `user-erase-${userId}`,
    requestHash: userErasureRequestHash(tenantId, userId),
    atMs,
  };
}

function jobAuthorization(claim: ErasureJobClaim): ErasureJobAuthorization {
  return {
    tenantId: claim.tenantId,
    subjectKind: claim.subjectKind,
    subjectId: claim.subjectId,
    requestId: claim.requestId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

function writeAuthorization(claim: ErasureJobClaim): ErasureWriteAuthorization {
  if (claim.subjectKind !== "user") throw new Error("test requires a user erasure claim");
  return {
    tenantId: claim.tenantId,
    userId: claim.subjectId,
    requestId: claim.requestId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

async function claimRequest(
  store: MemorySessionStore,
  requestId: string,
  nowMs: number,
  claimToken: string,
): Promise<ErasureJobClaim> {
  const claim = (await store.claimErasureJobs({
    nowMs,
    limit: 100,
    leaseMs: 100_000,
    claimToken,
  })).find((candidate) => candidate.requestId === requestId);
  expect(claim).toBeDefined();
  return claim!;
}

async function advanceToAwaitingPurgePolicy(
  store: MemorySessionStore,
  tenantId: string,
  userId: string,
  atMs: number,
) {
  const input = userRequestInput(tenantId, userId, atMs);
  await store.requestUserErasure(input);
  const transitions = [
    ["gated", "draining"],
    ["draining", "tombstoning"],
    ["tombstoning", "reconciling_usage"],
    ["reconciling_usage", "awaiting_purge_policy"],
  ] as const;
  for (const [index, [fromStatus, toStatus]] of transitions.entries()) {
    const transitionAtMs = atMs + index + 1;
    const claim = await claimRequest(
      store,
      input.requestId,
      transitionAtMs,
      `memory-authority-${userId.slice(-8)}-${index}`,
    );
    expect(claim.status).toBe(fromStatus);
    expect(await store.transitionErasureJob(jobAuthorization(claim), {
      fromStatus,
      toStatus,
      atMs: transitionAtMs,
      ...(toStatus === "awaiting_purge_policy" ? {} : { availableAtMs: transitionAtMs }),
    })).toBe(true);
  }
  return input;
}

function installOrphanTenantEvidence(
  store: MemorySessionStore,
  evidenceKind: "admission" | "fence",
  tenantId: string,
  atMs: number,
): void {
  const requestId = newErasureRequestId();
  if (evidenceKind === "admission") {
    store.tenantErasureAdmissions.set(requestId, {
      requestId,
      tenantId,
      subjectKind: "tenant",
      subjectId: tenantId,
      generation: 1,
      status: "gated",
      requestedByKeyId: "platform-lifecycle-admin",
      idempotencyKey: `orphan-${tenantId}`,
      requestHash: tenantErasureRequestHash(tenantId),
      createdAtMs: atMs,
      gatedAtMs: atMs,
      updatedAtMs: atMs,
      attempts: 0,
      controlGeneration: 0,
    });
    return;
  }
  const fenceBase = {
    tenantId,
    requestId,
    subjectGeneration: 1,
    fencedAtMs: atMs,
  };
  store.tenantCredentialRevocationFences.set(tenantId, {
    ...fenceBase,
    evidenceSha256: tenantCredentialRevocationFenceSha256(fenceBase),
  });
}

function provider(
  tenantId: string,
  id = "provider",
  apiKeyRef?: string,
): ProviderConfig {
  return {
    tenantId,
    id,
    api: "openai-completions",
    baseUrl: "https://example.com/v1",
    ...(apiKeyRef === undefined ? {} : { apiKeyRef }),
    headers: {},
    models: [{
      id: "model",
      contextWindow: 1_000,
      maxOutputTokens: 100,
      input: ["text"],
      reasoning: false,
    }],
    quota: {},
    fallback: [],
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
}

function agent(tenantId: string): AgentDefinition {
  return {
    id: newId("agt"),
    tenantId,
    version: 1,
    name: "tenant fence test",
    instructions: "test",
    model: { provider: "provider", model: "model" },
    tools: [],
    mcpServers: [],
    skills: [],
    limits: {},
    approvalPolicy: "never",
    busyPolicy: "reject",
    sandbox: "none",
    metadata: {},
    createdAtMs: NOW,
  };
}

describe("MemorySessionStore tenant credential revocation fence", () => {
  it("atomically gates a tenant, records evidence, and makes every credential family fail closed", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-fence";
    const neighborId = "tenant-neighbor";
    const session = mkSession(tenantId, "user-fence");
    const definition = agent(tenantId);
    await store.createSession(session);
    await store.createAgent(definition);
    await store.upsertProviderConfig(provider(tenantId, "provider", `secret:${tenantId}:provider`), {
      ciphertext: Buffer.from("encrypted-provider-key"),
      keyId: "local-v1",
    });
    await store.createApiKey(tenantId, "tenant-key", "tenant-key-hash", ["runtime"]);
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    await store.createApiKey(neighborId, "neighbor-key", "neighbor-key-hash", ["runtime"]);
    await store.upsertProviderConfig(provider(neighborId));

    const input = requestInput(tenantId);
    const created = await store.requestTenantErasure(input);

    expect(created).toMatchObject({
      requestId: input.requestId,
      tenantId,
      subjectKind: "tenant",
      subjectId: tenantId,
      generation: 1,
      status: "gated",
      attempts: 0,
    });
    expect(created).not.toHaveProperty("availableAtMs");
    expect(await store.getTenantRuntimeState(tenantId)).toEqual({
      tenantId,
      state: "deleting",
      generation: 1,
      activeRequestId: input.requestId,
    });
    expect(await store.getTenantErasureRequest(tenantId, input.requestId)).toEqual(created);
    const fence = await store.getTenantCredentialRevocationFence(tenantId, input.requestId);
    expect(fence).toEqual({
      tenantId,
      requestId: input.requestId,
      subjectGeneration: 1,
      fencedAtMs: input.atMs,
      evidenceSha256: tenantCredentialRevocationFenceSha256({
        tenantId,
        requestId: input.requestId,
        subjectGeneration: 1,
        fencedAtMs: input.atMs,
      }),
    });
    expect(await store.listErasureAuditEvents(input.requestId)).toEqual([{
      requestId: input.requestId,
      seq: 1,
      type: "erasure/gated",
      payload: {
        status: "gated",
        subjectKind: "tenant",
        generation: 1,
        credentialFence: "logical-v1",
      },
      emittedAtMs: input.atMs,
    }]);
    expect(await store.claimErasureJobs({
      nowMs: input.atMs + 1,
      limit: 10,
      leaseMs: 1_000,
      claimToken: "tenant-fence-must-remain-dormant",
    })).toEqual([]);

    expect(await store.resolveApiKey("tenant-key-hash")).toBeNull();
    expect(await store.listApiKeys(tenantId)).toEqual([]);
    expect(await store.getTenant(tenantId)).toBeNull();
    expect(await store.getProviderConfig(tenantId, "provider")).toBeNull();
    expect(await store.listProviderConfigs(tenantId)).toEqual([]);
    expect(await store.getAgent(tenantId, definition.id, 1)).toBeNull();
    expect(await store.listAgents(tenantId, { limit: 10 })).toEqual({ data: [], nextCursor: null });
    expect(await store.getSession(tenantId, session.id)).toBeNull();

    await expect(store.createApiKey(tenantId, "late-key", "late-key-hash"))
      .rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(store.revokeApiKey(tenantId, "tenant-key"))
      .rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY))
      .rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(store.upsertProviderConfig(provider(tenantId, "late")))
      .rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(store.deleteProviderConfig(tenantId, "provider"))
      .rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(store.createAgent({ ...definition, id: newId("agt") }))
      .rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(store.createSession(mkSession(tenantId, "late-user")))
      .rejects.toBeInstanceOf(SubjectDeletingError);

    expect(await store.resolveApiKey("neighbor-key-hash")).toMatchObject({ tenantId: neighborId });
    expect(await store.getProviderConfig(neighborId, "provider")).toMatchObject({
      config: { tenantId: neighborId },
    });
  });

  it("fences tenant-key governance mutations while leaving a neighboring tenant writable", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-governance-fence";
    const neighborId = "tenant-governance-neighbor";
    const holdId = newLegalHoldId();
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    await store.putRetentionPolicy({
      tenantId,
      policyVersion: "policy-before",
      policy: retentionPolicy(1),
      actorKeyId: "tenant-admin",
      atMs: NOW,
    });
    await store.putRetentionPolicy({
      tenantId,
      policyVersion: "policy-next",
      policy: retentionPolicy(2),
      actorKeyId: "tenant-admin",
      atMs: NOW + 1,
    });
    await store.activateRetentionPolicy({
      tenantId,
      policyVersion: "policy-before",
      expectedControlGeneration: 0,
      actorKeyId: "tenant-admin",
      atMs: NOW + 2,
    });
    await store.setLegalHold({
      tenantId,
      holdId,
      subjectKind: "tenant",
      subjectId: tenantId,
      reasonCode: "litigation",
      expectedControlGeneration: 0,
      actorKeyId: "tenant-admin",
      atMs: NOW + 3,
    });

    await store.requestTenantErasure(requestInput(tenantId, "governance-fence"));

    await expect(store.putRetentionPolicy({
      tenantId,
      policyVersion: "policy-after",
      policy: retentionPolicy(3),
      actorKeyId: "tenant-admin",
      atMs: NOW + 4,
    })).rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(store.activateRetentionPolicy({
      tenantId,
      policyVersion: "policy-next",
      expectedControlGeneration: 1,
      actorKeyId: "tenant-admin",
      atMs: NOW + 4,
    })).rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(store.setLegalHold({
      tenantId,
      holdId: newLegalHoldId(),
      subjectKind: "tenant",
      subjectId: tenantId,
      reasonCode: "regulatory",
      expectedControlGeneration: 1,
      actorKeyId: "tenant-admin",
      atMs: NOW + 4,
    })).rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(store.releaseLegalHold({
      tenantId,
      holdId,
      expectedControlGeneration: 1,
      reasonCode: "matter_closed",
      actorKeyId: "tenant-admin",
      atMs: NOW + 4,
    })).rejects.toBeInstanceOf(SubjectDeletingError);

    expect((await store.getActiveRetentionPolicy(tenantId))?.policy.policyVersion)
      .toBe("policy-before");
    expect(await store.getLegalHold(tenantId, holdId)).toMatchObject({ state: "active" });

    await store.putRetentionPolicy({
      tenantId: neighborId,
      policyVersion: "neighbor-policy",
      policy: retentionPolicy(4),
      actorKeyId: "neighbor-admin",
      atMs: NOW + 4,
    });
    expect(await store.activateRetentionPolicy({
      tenantId: neighborId,
      policyVersion: "neighbor-policy",
      expectedControlGeneration: 0,
      actorKeyId: "neighbor-admin",
      atMs: NOW + 5,
    })).toMatchObject({ activePolicyVersion: "neighbor-policy" });
    const neighborHold = await store.setLegalHold({
      tenantId: neighborId,
      holdId: newLegalHoldId(),
      subjectKind: "tenant",
      subjectId: neighborId,
      reasonCode: "litigation",
      expectedControlGeneration: 0,
      actorKeyId: "neighbor-admin",
      atMs: NOW + 6,
    });
    expect(await store.releaseLegalHold({
      tenantId: neighborId,
      holdId: neighborHold.holdId,
      expectedControlGeneration: 1,
      reasonCode: "matter_closed",
      actorKeyId: "neighbor-admin",
      atMs: NOW + 7,
    })).toMatchObject({ state: "released" });
  });

  it("replays stably, rejects a mismatched durable binding, and admits only one concurrent request", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-replay";
    const first = requestInput(tenantId, "shared-key");
    const replay = { ...first, requestId: newErasureRequestId(), atMs: first.atMs + 1 };

    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    const created = await store.requestTenantErasure(first);
    // Replay is authoritative before the independent registry-existence check.
    store.tenants.delete(tenantId);
    expect(await store.requestTenantErasure(replay)).toEqual(created);
    expect(await store.requestTenantErasure({
      ...replay,
      requestId: newErasureRequestId(),
      idempotencyKey: "another-key",
    })).toEqual(created);

    // A rolling-version/corrupt historical row with a different request digest must never replay
    // merely because the idempotency tuple still points to it.
    store.tenantErasureAdmissions.get(first.requestId)!.requestHash = "a".repeat(64);
    await expect(store.requestTenantErasure(replay))
      .rejects.toBeInstanceOf(ErasureIdempotencyMismatchError);

    const concurrent = new MemorySessionStore();
    await concurrent.setTenantAuth("tenant-concurrent", DEFAULT_AUTH_POLICY);
    const [left, right] = await Promise.all([
      concurrent.requestTenantErasure(requestInput("tenant-concurrent", "left")),
      concurrent.requestTenantErasure(requestInput("tenant-concurrent", "right")),
    ]);
    expect(right).toEqual(left);
    expect(concurrent.erasureRequests).toHaveLength(0);
    expect(concurrent.tenantErasureAdmissions).toHaveLength(1);
    expect(concurrent.erasureAuditEvents).toHaveLength(1);
    expect(concurrent.tenantCredentialRevocationFences).toHaveLength(1);
    expect(await concurrent.getTenantRuntimeState("tenant-concurrent")).toMatchObject({
      state: "deleting",
      generation: 1,
      activeRequestId: left.requestId,
    });
  });

  it("recovers only an exact committed tenant replay without admission authority", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-replay-only";
    const input = requestInput(tenantId, "recover-r\u00e9sponse");
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    await store.setTenantAuth("tenant-replay-neighbor", DEFAULT_AUTH_POLICY);
    const created = await store.requestTenantErasure(input);
    const sizes = () => ({
      admissions: store.tenantErasureAdmissions.size,
      lifecycles: store.subjectLifecycles.size,
      audits: store.erasureAuditEvents.size,
      fences: store.tenantCredentialRevocationFences.size,
    });
    const before = sizes();

    store.tenants.delete(tenantId);
    expect(await store.replayTenantErasure({
      tenantId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
    })).toEqual(created);
    expect(await store.replayTenantErasure({
      tenantId,
      idempotencyKey: "different-key",
      requestHash: input.requestHash,
    })).toBeNull();
    expect(await store.replayTenantErasure({
      tenantId,
      idempotencyKey: "recover-re\u0301sponse",
      requestHash: input.requestHash,
    })).toBeNull();
    expect(await store.replayTenantErasure({
      tenantId: "tenant-replay-neighbor",
      idempotencyKey: input.idempotencyKey,
      requestHash: tenantErasureRequestHash("tenant-replay-neighbor"),
    })).toBeNull();
    expect(sizes()).toEqual(before);

    store.tenantCredentialRevocationFences.delete(tenantId);
    await expect(store.replayTenantErasure({
      tenantId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
    })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
  });

  it("rejects nonexistent tenants without residue and does not treat incidental data as identity", async () => {
    const emptyStore = new MemorySessionStore();
    const missing = requestInput("tenant-does-not-exist", "missing-tenant");
    await expect(emptyStore.requestTenantErasure(missing))
      .rejects.toBeInstanceOf(TenantErasureTargetNotFoundError);
    expect(emptyStore.tenants).toHaveLength(0);
    expect(emptyStore.subjectLifecycles).toHaveLength(0);
    expect(emptyStore.tenantErasureAdmissions).toHaveLength(0);
    expect(emptyStore.erasureAuditEvents).toHaveLength(0);
    expect(emptyStore.tenantCredentialRevocationFences).toHaveLength(0);

    const incidentalStore = new MemorySessionStore();
    const tenantId = "tenant-incidental-data-only";
    const session = mkSession(tenantId, "user-incidental");
    await incidentalStore.createSession(session);
    const lifecycleBefore = structuredClone([...incidentalStore.subjectLifecycles.entries()]);
    await expect(incidentalStore.requestTenantErasure(requestInput(tenantId, "incidental")))
      .rejects.toBeInstanceOf(TenantErasureTargetNotFoundError);
    expect([...incidentalStore.subjectLifecycles.entries()]).toEqual(lifecycleBefore);
    expect(incidentalStore.tenants).toHaveLength(0);
    expect(incidentalStore.tenantErasureAdmissions).toHaveLength(0);
    expect(incidentalStore.erasureAuditEvents).toHaveLength(0);
    expect(incidentalStore.tenantCredentialRevocationFences).toHaveLength(0);
  });

  it("requires lifecycle, credential-fence, and first-audit proof on tenant status reads", async () => {
    const assertIntegrityFailure = async (
      promise: Promise<unknown>,
      tenantId: string,
      requestId: string,
    ) => {
      try {
        await promise;
        throw new Error("expected tenant-erasure integrity failure");
      } catch (error) {
        expect(error).toBeInstanceOf(TenantErasureIntegrityError);
        expect((error as Error).message).toBe("tenant erasure integrity proof is invalid");
        expect((error as Error).message).not.toContain(tenantId);
        expect((error as Error).message).not.toContain(requestId);
      }
    };

    for (const corruption of ["lifecycle", "fence", "audit", "admission"] as const) {
      const store = new MemorySessionStore();
      const tenantId = `tenant-status-corrupt-${corruption}`;
      const input = requestInput(tenantId, `status-corrupt-${corruption}`);
      await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
      await store.requestTenantErasure(input);
      if (corruption === "lifecycle") {
        store.subjectLifecycles.get(subjectLifecycleKey(tenantId, "tenant", tenantId))!
          .generation += 1;
      } else if (corruption === "fence") {
        store.tenantCredentialRevocationFences.delete(tenantId);
      } else if (corruption === "audit") {
        store.erasureAuditEvents.delete(input.requestId);
      } else {
        store.tenantErasureAdmissions.delete(input.requestId);
      }
      await assertIntegrityFailure(
        store.getTenantErasureRequest(tenantId, input.requestId),
        tenantId,
        input.requestId,
      );
      expect(await store.getTenantErasureRequest("tenant-status-neighbor", input.requestId))
        .toBeNull();
    }
  });

  it("validates and clones before publication, then rolls back every map on a late failure", async () => {
    const invalidStore = new MemorySessionStore();
    const invalid = requestInput("tenant-invalid");
    await expect(invalidStore.requestTenantErasure({
      ...invalid,
      requestedByKeyId: "invalid actor",
    })).rejects.toThrow("invalid erasure actor key id");
    await expect(invalidStore.requestTenantErasure({
      ...invalid,
      idempotencyKey: (() => undefined) as never,
    })).rejects.toBeDefined();
    expect(invalidStore.subjectLifecycles).toHaveLength(0);
    expect(invalidStore.erasureRequests).toHaveLength(0);
    expect(invalidStore.tenantErasureAdmissions).toHaveLength(0);
    expect(invalidStore.erasureAuditEvents).toHaveLength(0);
    expect(invalidStore.tenantCredentialRevocationFences).toHaveLength(0);

    const store = new MemorySessionStore();
    const input = requestInput("tenant-rollback");
    await store.setTenantAuth(input.tenantId, DEFAULT_AUTH_POLICY);
    const lifecycle = store.subjectLifecycles;
    const originalSet = lifecycle.set.bind(lifecycle);
    let fail = true;
    Object.defineProperty(lifecycle, "set", {
      configurable: true,
      value: (key: string, value: unknown) => {
        if (fail && (value as { state?: string }).state === "deleting") {
          fail = false;
          throw new Error("injected tenant gate publication failure");
        }
        return originalSet(key, value as never);
      },
    });

    await expect(store.requestTenantErasure(input))
      .rejects.toThrow("injected tenant gate publication failure");
    expect(store.subjectLifecycles).toHaveLength(0);
    expect(store.erasureRequests).toHaveLength(0);
    expect(store.tenantErasureAdmissions).toHaveLength(0);
    expect(store.erasureAuditEvents).toHaveLength(0);
    expect(store.tenantCredentialRevocationFences).toHaveLength(0);
    expect(await store.getTenantRuntimeState(input.tenantId)).toEqual({
      tenantId: input.tenantId,
      state: "active",
      generation: 0,
    });
  });

  it("preserves first API-key digest ownership and tuple-isolates provider rows", async () => {
    const store = new MemorySessionStore();
    await store.createApiKey("tenant-owner", "owner-key", "shared-hash");
    await store.createApiKey("tenant-attacker", "attacker-key", "shared-hash");
    expect(await store.resolveApiKey("shared-hash")).toMatchObject({
      tenantId: "tenant-owner",
      keyId: "owner-key",
    });

    // Both tuples were the same raw `${tenantId}/${providerId}` key before tuple encoding.
    await store.upsertProviderConfig(provider("tenant:/%", "p"));
    await store.upsertProviderConfig(provider("tenant:", "%/p"));
    expect(await store.getProviderConfig("tenant:/%", "p")).toMatchObject({
      config: { tenantId: "tenant:/%", id: "p" },
    });
    expect(await store.getProviderConfig("tenant:", "%/p")).toMatchObject({
      config: { tenantId: "tenant:", id: "%/p" },
    });
  });

  it("does not resurrect credentials when append-only fence evidence outlives its lifecycle row", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-missing-lifecycle";
    const requestId = newErasureRequestId();
    const fenceBase = {
      tenantId,
      requestId,
      subjectGeneration: 1,
      fencedAtMs: NOW,
    };
    await store.createApiKey(tenantId, "fenced-key", "fenced-key-hash");
    store.tenantCredentialRevocationFences.set(tenantId, {
      ...fenceBase,
      evidenceSha256: tenantCredentialRevocationFenceSha256(fenceBase),
    });

    expect(await store.resolveApiKey("fenced-key-hash")).toBeNull();
    await expect(store.createApiKey(tenantId, "late-key", "late-fenced-hash"))
      .rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(store.getTenantRuntimeState(tenantId))
      .rejects.toThrow("tenant lifecycle gate is missing");
  });

  it("fails closed when an append-only admission survives an active lifecycle and missing fence", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-orphan-admission";
    const neighborId = "tenant-orphan-neighbor";
    const targetHash = "orphan-admission-hash";
    const neighborHash = "orphan-neighbor-hash";
    await store.createApiKey(tenantId, "target-key", targetHash);
    await store.createApiKey(neighborId, "neighbor-key", neighborHash);
    await store.requestTenantErasure(requestInput(tenantId));

    // Simulate partial/corrupt restoration: immutable admission evidence survived while the
    // lifecycle was resurrected as active and the redundant fence was lost.
    store.tenantCredentialRevocationFences.delete(tenantId);
    store.subjectLifecycles.set(subjectLifecycleKey(tenantId, "tenant", tenantId), {
      tenantId,
      subjectKind: "tenant",
      subjectId: tenantId,
      state: "active",
      generation: 0,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });

    expect(await store.resolveApiKey(targetHash)).toBeNull();
    await expect(store.createApiKey(tenantId, "late-key", "late-orphan-hash"))
      .rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(store.requestTenantErasure(requestInput(tenantId, "second-request")))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.getTenantRuntimeState(tenantId))
      .rejects.toThrow("tenant lifecycle and credential fence do not agree");
    expect(await store.resolveApiKey(neighborHash)).toMatchObject({
      tenantId: neighborId,
      keyId: "neighbor-key",
    });
  });

  it("refuses tenant admission while a user worker retains destructive authority", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-user-conflict";
    await store.createApiKey(tenantId, "still-live", "still-live-hash");
    await store.requestUserErasure({
      requestId: newErasureRequestId(),
      tenantId,
      userId: "user-conflict",
      requestedByKeyId: "tenant-admin",
      idempotencyKey: "user-first",
      requestHash: userErasureRequestHash(tenantId, "user-conflict"),
      atMs: NOW,
    });

    await expect(store.requestTenantErasure(requestInput(tenantId)))
      .rejects.toBeInstanceOf(TenantErasureConflictError);
    expect(await store.getTenantRuntimeState(tenantId)).toEqual({
      tenantId,
      state: "active",
      generation: 0,
    });
    expect(await store.resolveApiKey("still-live-hash")).toMatchObject({ tenantId });
    expect(store.tenantCredentialRevocationFences).toHaveLength(0);
  });

  it.each(["admission", "fence"] as const)(
    "revokes user worker and purge evaluator authority when orphan tenant %s evidence survives an active lifecycle",
    async (evidenceKind) => {
      const store = new MemorySessionStore();
      const tenantId = `tenant-authority-${evidenceKind}`;
      const neighborId = `tenant-authority-neighbor-${evidenceKind}`;
      const session = mkSession(tenantId, `user-session-${evidenceKind}`);
      await store.createSession(session);

      const existingInput = userRequestInput(tenantId, session.userId, NOW + 10);
      await store.requestUserErasure(existingInput);
      const gated = await claimRequest(
        store,
        existingInput.requestId,
        NOW + 11,
        `memory-existing-gated-${evidenceKind}`,
      );
      expect(await store.transitionErasureJob(jobAuthorization(gated), {
        fromStatus: "gated",
        toStatus: "draining",
        atMs: NOW + 11,
        availableAtMs: NOW + 11,
      })).toBe(true);
      const existingClaim = await claimRequest(
        store,
        existingInput.requestId,
        NOW + 12,
        `memory-existing-draining-${evidenceKind}`,
      );

      const repairInput = userRequestInput(
        tenantId,
        `user-repair-${evidenceKind}`,
        NOW + 50,
      );
      await store.requestUserErasure(repairInput);
      delete store.erasureRequests.get(repairInput.requestId)!.availableAtMs;
      expect(await store.claimErasureJobs({
        nowMs: NOW + 51,
        limit: 1,
        leaseMs: 100_000,
        claimToken: `memory-repair-quarantine-${evidenceKind}`,
      })).toEqual([]);
      const repairIdentity = {
        tenantId,
        subjectKind: "user" as const,
        subjectId: repairInput.userId,
        requestId: repairInput.requestId,
        subjectGeneration: 1,
      };
      const repairInspection = (await store.inspectErasureJobIntervention(repairIdentity))!;
      expect(repairInspection).toMatchObject({
        reasonCode: "queue_control_invalid",
        allowedActions: ["normalize_queue_control"],
      });

      const scheduleInput = await advanceToAwaitingPurgePolicy(
        store,
        tenantId,
        `user-schedule-${evidenceKind}`,
        NOW + 100,
      );
      const targetEvaluationInput = await advanceToAwaitingPurgePolicy(
        store,
        tenantId,
        `user-evaluation-${evidenceKind}`,
        NOW + 200,
      );
      const neighborEvaluationInput = await advanceToAwaitingPurgePolicy(
        store,
        neighborId,
        `user-evaluation-neighbor-${evidenceKind}`,
        NOW + 300,
      );
      store.erasurePolicyEvaluationJobs.delete(scheduleInput.requestId);

      const targetPending = userRequestInput(
        tenantId,
        `user-pending-${evidenceKind}`,
        NOW + 500,
      );
      const neighborPending = userRequestInput(
        neighborId,
        `user-pending-neighbor-${evidenceKind}`,
        NOW + 501,
      );
      await store.requestUserErasure(targetPending);
      await store.requestUserErasure(neighborPending);

      installOrphanTenantEvidence(store, evidenceKind, tenantId, NOW + 1_000);
      expect(await store.getSubjectLifecycle(tenantId, "tenant", tenantId)).toMatchObject({
        state: "active",
        generation: 0,
      });
      await expect(store.getTenantRuntimeState(tenantId))
        .rejects.toThrow("tenant lifecycle and credential fence do not agree");

      const existingAuthority = jobAuthorization(existingClaim);
      expect(await store.renewErasureJobClaim(existingAuthority, {
        nowMs: NOW + 1_001,
        leaseMs: 100_000,
      })).toBe(false);
      expect(await store.transitionErasureJob(existingAuthority, {
        fromStatus: "draining",
        toStatus: "tombstoning",
        atMs: NOW + 1_001,
        availableAtMs: NOW + 1_001,
      })).toBe(false);
      await expect(store.applyErasureSessionAction({
        authority: writeAuthorization(existingClaim),
        sessionId: session.id,
        fence: 1,
        action: "fence",
      })).rejects.toThrow("stale erasure authority");
      expect(await store.inspectErasureJobIntervention(repairIdentity)).toMatchObject({
        controlGeneration: repairInspection.controlGeneration,
        allowedActions: ["normalize_queue_control"],
      });
      expect(await store.repairAndResumeErasureJob({
        ...repairIdentity,
        expectedControlGeneration: repairInspection.controlGeneration,
        expectedEvidenceSha256: repairInspection.evidenceSha256,
        actorKeyId: `memory-repair-admin-${evidenceKind}`,
        actionCode: "normalize_queue_control",
        atMs: NOW + 1_001,
      })).toBe(false);

      const [neighborClaim] = await store.claimErasureJobs({
        nowMs: NOW + 1_001,
        limit: 1,
        leaseMs: 100_000,
        claimToken: `memory-neighbor-worker-${evidenceKind}`,
      });
      expect(neighborClaim).toMatchObject({
        requestId: neighborPending.requestId,
        tenantId: neighborId,
      });
      expect((await store.getUserErasureRequest(
        tenantId,
        targetPending.userId,
        targetPending.requestId,
      ))?.attempts).toBe(0);

      expect(await store.scheduleAwaitingErasurePolicyEvaluations({
        nowMs: NOW + 1_001,
        limit: 1,
      })).toBe(0);
      expect(await store.getErasurePolicyEvaluationJob(scheduleInput.requestId)).toBeNull();

      const [neighborEvaluationClaim] = await store.claimErasurePolicyEvaluations({
        nowMs: NOW + 1_001,
        limit: 1,
        leaseMs: 100_000,
        claimToken: `memory-neighbor-evaluator-${evidenceKind}`,
      });
      expect(neighborEvaluationClaim).toMatchObject({
        requestId: neighborEvaluationInput.requestId,
        tenantId: neighborId,
      });
      expect(await store.getErasurePolicyEvaluationJob(targetEvaluationInput.requestId))
        .toMatchObject({ attempts: 0 });
    },
  );
});
