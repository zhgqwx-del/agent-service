import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  type AgentDefinition,
  type ProviderConfig,
  type TenantAuthPolicy,
} from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import {
  CredentialSourceConflictError,
  MemorySessionStore,
  TenantErasureIntegrityError,
  newErasureRequestId,
  tenantCredentialCurrentTargetDisposition,
  tenantCredentialSlotIdSha256,
  tenantCredentialSubjectEvidenceSha256,
  tenantCredentialTargetDispositionEvidenceSha256,
  tenantCredentialVersionEvidenceSha256,
  tenantErasureRequestHash,
  type TenantCredentialRevocationAuthorization,
  type TenantCredentialRevocationClaim,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const AUTH_POLICY: TenantAuthPolicy = {
  mode: "end_user_token",
  tokenHeader: "x-end-user-token",
  verifier: {
    kind: "jwt",
    hs256: true,
    algorithms: ["HS256"],
    subjectClaim: "sub",
    clockToleranceSec: 0,
  },
};

function provider(
  tenantId: string,
  id: string,
  options: {
    headers?: Record<string, string>;
    baseUrl?: string;
    marker?: string;
    apiKeyRef?: string;
  } = {},
): ProviderConfig {
  return {
    tenantId,
    id,
    api: "openai-completions",
    baseUrl: options.baseUrl ?? "https://example.invalid/v1",
    ...(options.apiKeyRef === undefined ? {} : { apiKeyRef: options.apiKeyRef }),
    headers: options.headers ?? {},
    models: [{
      id: options.marker ?? "model",
      contextWindow: 1_000,
      maxOutputTokens: 100,
      input: ["text"],
      reasoning: false,
    }],
    quota: {},
    fallback: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function agent(tenantId: string): AgentDefinition {
  return {
    id: newId("agt"),
    tenantId,
    version: 1,
    name: "credential lifecycle fixture",
    instructions: "test",
    model: { provider: "platform", model: "fixture" },
    tools: [],
    mcpServers: [],
    skills: [],
    limits: { maxSteps: 1 },
    approvalPolicy: "on-request",
    busyPolicy: "steer",
    sandbox: "none",
    metadata: {},
    createdAtMs: 1,
  };
}

function authorization(
  claim: TenantCredentialRevocationClaim,
): TenantCredentialRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

async function requestAndClaim(
  store: MemorySessionStore,
  tenantId: string,
  atMs: number,
): Promise<TenantCredentialRevocationClaim> {
  const requestId = newErasureRequestId();
  await store.requestTenantErasure({
    requestId,
    tenantId,
    requestedByKeyId: "credential-lifecycle-test",
    idempotencyKey: `credential-lifecycle-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs,
  });
  const claims = await store.claimTenantCredentialRevocations({
    limit: 10,
    leaseMs: 1_000,
    claimToken: `claim-${randomUUID()}`,
  });
  const claim = claims.find((candidate) => candidate.requestId === requestId);
  if (!claim) throw new Error("expected credential revocation claim");
  return claim;
}

describe("MemorySessionStore credential lifecycle inventory", () => {
  it("activates from legacy state once and inventories every old tenant without claiming history", async () => {
    const store = new MemorySessionStore({ now: () => 1_000 });
    await store.setTenantAuth("legacy-credential", AUTH_POLICY, {
      ciphertext: Buffer.from("legacy-auth-secret"),
      keyId: "legacy-auth-key",
    });
    await store.upsertProviderConfig(
      provider("legacy-credential", "legacy-provider", {
        headers: { Authorization: "legacy-provider-header" },
        apiKeyRef: "secret:legacy-provider",
      }),
      { ciphertext: Buffer.from("legacy-provider-secret"), keyId: "legacy-provider-key" },
    );
    await store.createApiKey("legacy-empty", "legacy-empty-key", "legacy-empty-hash");
    await store.upsertProviderConfig(provider("legacy-empty", "keyless-provider"));

    await expect(store.getTenantCredentialInventorySnapshot("legacy-credential"))
      .rejects.toMatchObject({ name: "TenantErasureIntegrityError" });

    const cutover = await store.activateTenantCredentialTrackingCutover({
      expectedControlGeneration: 0,
    });
    expect(cutover).toMatchObject({
      controlGeneration: 1,
      activatedAtDbMs: 1_000,
      subjectCount: 2,
      providerSlotCount: 2,
      authSlotCount: 2,
      versionCount: 2,
      targetDispositionCount: 4,
    });
    expect(await store.activateTenantCredentialTrackingCutover({
      expectedControlGeneration: 0,
    })).toEqual(cutover);

    const credentialSnapshot = await store.getTenantCredentialInventorySnapshot(
      "legacy-credential",
    );
    expect(credentialSnapshot.subject).toMatchObject({
      historyStatus: "legacy_history_unknown",
      origin: "legacy_observed",
    });
    expect(credentialSnapshot.versions).toHaveLength(2);
    expect(credentialSnapshot.versions.every((version) => version.origin === "legacy_observed"))
      .toBe(true);
    expect(credentialSnapshot.targetDispositions).toHaveLength(4);

    const emptySnapshot = await store.getTenantCredentialInventorySnapshot("legacy-empty");
    expect(emptySnapshot.subject.historyStatus).toBe("legacy_history_unknown");
    expect(emptySnapshot.providerSlots).toHaveLength(1);
    expect(emptySnapshot.providerSlots[0]).toMatchObject({ sourcePresent: true });
    expect(emptySnapshot.providerSlots[0]).not.toHaveProperty("currentCredentialVersionId");
    expect(emptySnapshot.versions).toHaveLength(0);

    const serialized = JSON.stringify([credentialSnapshot, emptySnapshot]);
    for (const forbidden of [
      "legacy-provider",
      "legacy-auth-secret",
      "legacy-auth-key",
      "legacy-provider-header",
      "legacy-provider-secret",
      "legacy-provider-key",
      "https://example.invalid/v1",
    ]) expect(serialized).not.toContain(forbidden);
  });

  it("onboards session/agent-first tenants after cutover with complete tracking subjects", async () => {
    const store = new MemorySessionStore({ now: () => 1_500 });
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });

    const providerTenant = "post-cutover-session-provider";
    await store.createSession(mkSession(providerTenant, "provider-user"));
    await store.upsertProviderConfig(provider(providerTenant, "provider-after-session", {
      headers: { Authorization: "managed-header" },
    }), undefined, null);
    expect((await store.getTenantCredentialInventorySnapshot(providerTenant)).subject)
      .toMatchObject({ historyStatus: "complete_since_creation", origin: "managed_v1" });

    const authTenant = "post-cutover-session-auth";
    await store.createSession(mkSession(authTenant, "auth-user"));
    await store.setTenantAuth(authTenant, AUTH_POLICY, {
      ciphertext: Buffer.from("managed-auth-secret"),
      keyId: "managed-auth-key",
    }, null);
    expect((await store.getTenantCredentialInventorySnapshot(authTenant)).subject)
      .toMatchObject({ historyStatus: "complete_since_creation", origin: "managed_v1" });

    const apiKeyTenant = "post-cutover-agent-api-key";
    await store.createAgent(agent(apiKeyTenant));
    await store.createApiKey(apiKeyTenant, "managed-key", "managed-key-hash");
    expect((await store.getTenantCredentialInventorySnapshot(apiKeyTenant)).subject)
      .toMatchObject({ historyStatus: "complete_since_creation", origin: "managed_v1" });
  });

  it("rolls back first-source subject creation and rejects untracked provider credential channels", async () => {
    const store = new MemorySessionStore({ now: () => 1_600 });
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
    const tenantId = "post-cutover-first-source-rollback";
    await store.createSession(mkSession(tenantId, "rollback-user"));

    const subjects = store.tenantCredentialTrackingSubjects;
    const originalSubjectSet = subjects.set;
    subjects.set = function injected(key, value) {
      originalSubjectSet.call(this, key, value);
      throw new Error("injected first-source subject failure");
    };
    await expect(store.upsertProviderConfig(provider(tenantId, "must-rollback", {
      headers: { Authorization: "must-not-commit" },
    }), undefined, null)).rejects.toThrow("injected first-source subject failure");
    delete (subjects as unknown as { set?: unknown }).set;
    expect(store.providers).toHaveLength(0);
    expect(store.tenants).toHaveLength(0);
    expect(store.tenantCredentialTrackingSubjects).toHaveLength(0);
    expect(store.tenantCredentialProviderSlots).toHaveLength(0);
    expect(store.tenantCredentialVersions).toHaveLength(0);

    for (const [config, secret] of [
      [provider("invalid-provider-userinfo", "provider", {
        baseUrl: "https://user:password@example.invalid/v1",
      }), undefined],
      [provider("invalid-provider-ref", "provider", {
        apiKeyRef: "secret:missing-envelope",
      }), undefined],
      [provider("invalid-provider-envelope", "provider"), {
        ciphertext: Buffer.from("orphan-envelope"),
        keyId: "orphan-key",
      }],
    ] as const) {
      await expect(store.upsertProviderConfig(config, secret, null))
        .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    }

    const legacy = new MemorySessionStore({ now: () => 1_700 });
    const legacyTenant = "legacy-provider-userinfo";
    const legacyConfig = provider(legacyTenant, "legacy-provider", {
      baseUrl: "https://user:password@example.invalid/v1",
    });
    legacy.providers.set(JSON.stringify([legacyTenant, legacyConfig.id]), {
      config: legacyConfig,
    });
    await expect(legacy.activateTenantCredentialTrackingCutover({
      expectedControlGeneration: 0,
    })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(await legacy.readTenantCredentialTrackingCutover())
      .toEqual({ controlGeneration: 0 });
    expect(legacy.tenantCredentialTrackingSubjects).toHaveLength(0);
    expect(legacy.tenantCredentialVersions).toHaveLength(0);
  });

  it("versions provider material on every write and closes concurrent delete/recreate ABA", async () => {
    let nowMs = 2_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
    const tenantId = "managed-provider";
    // Provider ids use the existing free-form externalId contract; slot hashing must not narrow it.
    const providerId = "/%:p";
    const initial = provider(tenantId, providerId, {
      headers: { Authorization: "provider-header-v1" },
      apiKeyRef: "secret:managed-provider",
    });
    await store.upsertProviderConfig(
      initial,
      { ciphertext: Buffer.from("provider-secret-v1"), keyId: "provider-key-v1" },
      null,
    );
    expect((await store.getProviderConfig(tenantId, providerId))?.credentialSourceRevision)
      .toBe(1);

    nowMs += 1;
    await store.upsertProviderConfig(
      provider(tenantId, providerId, {
        headers: { Authorization: "provider-header-v2" },
        marker: "second-write",
        apiKeyRef: "secret:managed-provider",
      }),
      undefined,
      1,
    );
    const afterSecond = await store.getTenantCredentialInventorySnapshot(tenantId);
    expect(afterSecond.versions).toHaveLength(2);
    expect(afterSecond.versions.filter((version) => version.retiredAtDbMs === undefined))
      .toHaveLength(1);
    expect(afterSecond.versions.find((version) => version.retireReason === "replaced"))
      .toBeDefined();

    nowMs += 1;
    const concurrent = await Promise.allSettled([
      store.upsertProviderConfig(
        provider(tenantId, providerId, {
          headers: { Authorization: "provider-concurrent-a" },
          marker: "concurrent-a",
          apiKeyRef: "secret:managed-provider",
        }),
        undefined,
        2,
      ),
      store.upsertProviderConfig(
        provider(tenantId, providerId, {
          headers: { Authorization: "provider-concurrent-b" },
          marker: "concurrent-b",
          apiKeyRef: "secret:managed-provider",
        }),
        undefined,
        2,
      ),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = concurrent.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(CredentialSourceConflictError),
    });
    expect((await store.getProviderConfig(tenantId, providerId))?.credentialSourceRevision)
      .toBe(3);

    nowMs += 1;
    expect(await store.deleteProviderConfig(tenantId, providerId)).toBe(true);
    expect(await store.getProviderConfig(tenantId, providerId)).toBeNull();
    await expect(store.upsertProviderConfig(initial, undefined, null))
      .rejects.toBeInstanceOf(CredentialSourceConflictError);
    nowMs += 1;
    await store.upsertProviderConfig(initial, {
      ciphertext: Buffer.from("provider-secret-v2"),
      keyId: "provider-key-v2",
    }, 4);
    expect((await store.getProviderConfig(tenantId, providerId))?.credentialSourceRevision)
      .toBe(5);
    await expect(store.upsertProviderConfig(initial, undefined, 2))
      .rejects.toBeInstanceOf(CredentialSourceConflictError);

    const finalSnapshot = await store.getTenantCredentialInventorySnapshot(tenantId);
    expect(finalSnapshot.subject.historyStatus).toBe("complete_since_creation");
    expect(finalSnapshot.providerSlots).toEqual([
      expect.objectContaining({ sourcePresent: true, writeGeneration: 5 }),
    ]);
    expect(finalSnapshot.versions.filter((version) => version.retiredAtDbMs === undefined))
      .toHaveLength(1);
    expect(finalSnapshot.versions.some((version) => version.retireReason === "deleted"))
      .toBe(true);
    expect(JSON.stringify(finalSnapshot)).not.toContain(providerId);
  });

  it("preserves, replaces and clears auth secrets with monotonic CAS generations", async () => {
    let nowMs = 3_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
    const tenantId = "managed-auth";
    await store.setTenantAuth(
      tenantId,
      AUTH_POLICY,
      { ciphertext: Buffer.from("auth-secret-v1"), keyId: "auth-key-v1" },
      null,
    );
    nowMs += 1;
    const preserved = await store.setTenantAuth(tenantId, AUTH_POLICY, undefined, 1);
    expect(preserved.authCredentialSourceRevision).toBe(2);
    expect(preserved.authSecret?.keyId).toBe("auth-key-v1");
    await expect(store.setTenantAuth(tenantId, AUTH_POLICY, null, 1))
      .rejects.toBeInstanceOf(CredentialSourceConflictError);

    nowMs += 1;
    const cleared = await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY, null, 2);
    expect(cleared.authCredentialSourceRevision).toBe(3);
    expect(cleared.authSecret).toBeUndefined();
    nowMs += 1;
    await store.setTenantAuth(
      tenantId,
      AUTH_POLICY,
      { ciphertext: Buffer.from("auth-secret-v2"), keyId: "auth-key-v2" },
      3,
    );

    nowMs += 1;
    const concurrent = await Promise.allSettled([
      store.setTenantAuth(tenantId, AUTH_POLICY, undefined, 4),
      store.setTenantAuth(tenantId, AUTH_POLICY, undefined, 4),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.find((result) => result.status === "rejected"))
      .toMatchObject({ reason: expect.any(CredentialSourceConflictError) });

    const snapshot = await store.getTenantCredentialInventorySnapshot(tenantId);
    expect(snapshot.authSlot).toMatchObject({ sourcePresent: true, writeGeneration: 5 });
    expect(snapshot.versions.filter((version) => version.slotKind === "tenant_auth_secret"))
      .toHaveLength(4);
    expect(snapshot.versions.filter((version) => version.retiredAtDbMs === undefined))
      .toHaveLength(1);
    expect(snapshot.versions.some((version) => version.retireReason === "cleared")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("auth-secret-v2");
    expect(JSON.stringify(snapshot)).not.toContain("auth-key-v2");
  });

  it("rejects recomputed semantic tampering in auth-slot and target-version bindings", async () => {
    const store = new MemorySessionStore({ now: () => 3_500 });
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
    const tenantId = "semantic-tamper";
    await store.setTenantAuth(tenantId, AUTH_POLICY, {
      ciphertext: Buffer.from("tamper-auth-secret"),
      keyId: "tamper-auth-key",
    }, null);
    await store.upsertProviderConfig(provider(tenantId, "tamper-provider", {
      headers: { Authorization: "tamper-provider-header" },
      apiKeyRef: "secret:tamper-provider",
    }), {
      ciphertext: Buffer.from("tamper-provider-secret"),
      keyId: "tamper-provider-key",
    }, null);

    const original = await store.getTenantCredentialInventorySnapshot(tenantId);
    const subject = original.subject;
    store.tenantCredentialTrackingSubjects.set(tenantId, {
      ...subject,
      evidenceSha256: "0".repeat(64),
    });
    await expect(store.getTenantCredentialInventorySnapshot(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.getTenant(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.getProviderConfig(tenantId, "tamper-provider"))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.listProviderConfigs(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    const { evidenceSha256: _subjectEvidence, ...subjectBody } = subject;
    const lateSubjectBody = {
      ...subjectBody,
      trackingStartedAtDbMs: Math.max(
        ...original.versions.map((version) => version.createdAtDbMs),
      ) + 1,
    };
    store.tenantCredentialTrackingSubjects.set(tenantId, {
      ...lateSubjectBody,
      evidenceSha256: tenantCredentialSubjectEvidenceSha256(lateSubjectBody),
    });
    await expect(store.getTenantCredentialInventorySnapshot(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.getTenant(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.getProviderConfig(tenantId, "tamper-provider"))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.listProviderConfigs(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    store.tenantCredentialTrackingSubjects.set(tenantId, structuredClone(subject));

    const authVersion = original.versions.find((version) => (
      version.slotKind === "tenant_auth_secret" && version.retiredAtDbMs === undefined
    ));
    if (!authVersion) throw new Error("expected live auth version");
    const { evidenceSha256: _authEvidence, ...authBody } = authVersion;
    const wrongAuthBody = {
      ...authBody,
      slotIdSha256: tenantCredentialSlotIdSha256(
        tenantId,
        "provider_binding",
        "wrong-auth-slot",
      ),
    };
    store.tenantCredentialVersions.set(authVersion.credentialVersionId, {
      ...wrongAuthBody,
      evidenceSha256: tenantCredentialVersionEvidenceSha256(wrongAuthBody),
    });
    await expect(store.getTenantCredentialInventorySnapshot(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.getTenant(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    store.tenantCredentialVersions.set(authVersion.credentialVersionId, structuredClone(authVersion));
    const retiredAuthBody = {
      ...authBody,
      retiredAtDbMs: authBody.createdAtDbMs,
      retireReason: "replaced" as const,
    };
    store.tenantCredentialVersions.set(authVersion.credentialVersionId, {
      ...retiredAuthBody,
      evidenceSha256: tenantCredentialVersionEvidenceSha256(retiredAuthBody),
    });
    await expect(store.getTenant(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    store.tenantCredentialVersions.set(authVersion.credentialVersionId, structuredClone(authVersion));
    const authTargetEntry = [...store.tenantCredentialTargetDispositions.entries()].find(
      ([, target]) => target.credentialVersionId === authVersion.credentialVersionId
        && target.domain === "external_credential",
    );
    if (!authTargetEntry) throw new Error("expected auth external target");
    const [authTargetKey, authTarget] = authTargetEntry;
    const { evidenceSha256: _authTargetEvidence, ...authTargetBody } = authTarget;
    const wrongAuthTargetBody = {
      ...authTargetBody,
      disposition: "blocked_no_locator" as const,
    };
    store.tenantCredentialTargetDispositions.set(authTargetKey, {
      ...wrongAuthTargetBody,
      evidenceSha256: tenantCredentialTargetDispositionEvidenceSha256(wrongAuthTargetBody),
    });
    await expect(store.getTenant(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    store.tenantCredentialTargetDispositions.set(authTargetKey, structuredClone(authTarget));

    const authTargetEntries = [...store.tenantCredentialTargetDispositions.entries()].filter(
      ([, target]) => target.credentialVersionId === authVersion.credentialVersionId,
    );
    const shiftedAuthBody = {
      ...authBody,
      createdAtDbMs: authBody.createdAtDbMs + 1,
    };
    store.tenantCredentialVersions.set(authVersion.credentialVersionId, {
      ...shiftedAuthBody,
      evidenceSha256: tenantCredentialVersionEvidenceSha256(shiftedAuthBody),
    });
    for (const [key, target] of authTargetEntries) {
      const { evidenceSha256: _targetEvidence, ...body } = target;
      const shifted = { ...body, capturedAtDbMs: shiftedAuthBody.createdAtDbMs };
      store.tenantCredentialTargetDispositions.set(key, {
        ...shifted,
        evidenceSha256: tenantCredentialTargetDispositionEvidenceSha256(shifted),
      });
    }
    await expect(store.getTenantCredentialInventorySnapshot(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.getTenant(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    store.tenantCredentialVersions.set(authVersion.credentialVersionId, structuredClone(authVersion));
    for (const [key, target] of authTargetEntries) {
      store.tenantCredentialTargetDispositions.set(key, structuredClone(target));
    }

    const providerVersion = original.versions.find((version) => (
      version.slotKind === "provider_binding" && version.retiredAtDbMs === undefined
    ));
    if (!providerVersion) throw new Error("expected live provider version");
    const { evidenceSha256: _providerEvidence, ...providerBody } = providerVersion;
    const wrongProviderSlotBody = {
      ...providerBody,
      slotIdSha256: tenantCredentialSlotIdSha256(
        tenantId,
        "provider_binding",
        "other-provider",
      ),
    };
    store.tenantCredentialVersions.set(providerVersion.credentialVersionId, {
      ...wrongProviderSlotBody,
      evidenceSha256: tenantCredentialVersionEvidenceSha256(wrongProviderSlotBody),
    });
    await expect(store.getProviderConfig(tenantId, "tamper-provider"))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.listProviderConfigs(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);

    const wrongProviderMaterialBody = {
      ...providerBody,
      customHeadersPresent: false,
    };
    store.tenantCredentialVersions.set(providerVersion.credentialVersionId, {
      ...wrongProviderMaterialBody,
      evidenceSha256: tenantCredentialVersionEvidenceSha256(wrongProviderMaterialBody),
    });
    await expect(store.getProviderConfig(tenantId, "tamper-provider"))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);

    const retiredProviderBody = {
      ...providerBody,
      retiredAtDbMs: providerBody.createdAtDbMs,
      retireReason: "replaced" as const,
    };
    store.tenantCredentialVersions.set(providerVersion.credentialVersionId, {
      ...retiredProviderBody,
      evidenceSha256: tenantCredentialVersionEvidenceSha256(retiredProviderBody),
    });
    await expect(store.getProviderConfig(tenantId, "tamper-provider"))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    store.tenantCredentialVersions.set(
      providerVersion.credentialVersionId,
      structuredClone(providerVersion),
    );

    const targetEntry = [...store.tenantCredentialTargetDispositions.entries()].find(
      ([, target]) => target.credentialVersionId === providerVersion.credentialVersionId
        && target.domain === "external_credential",
    );
    if (!targetEntry) throw new Error("expected provider external target");
    const [targetKey, target] = targetEntry;
    const { evidenceSha256: _targetEvidence, ...targetBody } = target;
    const weakenedTargetBody = { ...targetBody, disposition: "not_applicable" as const };
    store.tenantCredentialTargetDispositions.set(targetKey, {
      ...weakenedTargetBody,
      evidenceSha256: tenantCredentialTargetDispositionEvidenceSha256(weakenedTargetBody),
    });
    await expect(store.getTenantCredentialInventorySnapshot(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.getProviderConfig(tenantId, "tamper-provider"))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.listProviderConfigs(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);

    const wrongTimeBody = { ...targetBody, capturedAtDbMs: target.capturedAtDbMs + 1 };
    store.tenantCredentialTargetDispositions.set(targetKey, {
      ...wrongTimeBody,
      evidenceSha256: tenantCredentialTargetDispositionEvidenceSha256(wrongTimeBody),
    });
    await expect(store.getTenantCredentialInventorySnapshot(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.getProviderConfig(tenantId, "tamper-provider"))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    store.tenantCredentialTargetDispositions.set(targetKey, structuredClone(target));

    const providerTargetEntries = [...store.tenantCredentialTargetDispositions.entries()].filter(
      ([, candidate]) => candidate.credentialVersionId === providerVersion.credentialVersionId,
    );
    const shiftedProviderBody = {
      ...providerBody,
      createdAtDbMs: providerBody.createdAtDbMs + 1,
    };
    store.tenantCredentialVersions.set(providerVersion.credentialVersionId, {
      ...shiftedProviderBody,
      evidenceSha256: tenantCredentialVersionEvidenceSha256(shiftedProviderBody),
    });
    for (const [key, candidate] of providerTargetEntries) {
      const { evidenceSha256: _targetEvidence, ...body } = candidate;
      const shifted = { ...body, capturedAtDbMs: shiftedProviderBody.createdAtDbMs };
      store.tenantCredentialTargetDispositions.set(key, {
        ...shifted,
        evidenceSha256: tenantCredentialTargetDispositionEvidenceSha256(shifted),
      });
    }
    await expect(store.getTenantCredentialInventorySnapshot(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.getProviderConfig(tenantId, "tamper-provider"))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    await expect(store.listProviderConfigs(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    store.tenantCredentialVersions.set(
      providerVersion.credentialVersionId,
      structuredClone(providerVersion),
    );
    for (const [key, candidate] of providerTargetEntries) {
      store.tenantCredentialTargetDispositions.set(key, structuredClone(candidate));
    }
    expect(await store.getTenantCredentialInventorySnapshot(tenantId)).toEqual(original);
  });

  it("fails snapshot and T3a atomically when provider source material drifts from its version", async () => {
    const store = new MemorySessionStore({ now: () => 3_750 });
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
    const tenantId = "provider-material-drift";
    await store.upsertProviderConfig(provider(tenantId, "material-provider", {
      baseUrl: "https://example.invalid/v1?region=test",
      headers: { Authorization: "material-header" },
      apiKeyRef: "secret:material-provider",
    }), {
      ciphertext: Buffer.from("material-secret"),
      keyId: "material-key",
    }, null);
    const validSnapshot = await store.getTenantCredentialInventorySnapshot(tenantId);
    const liveVersion = validSnapshot.versions.find((version) => (
      version.slotKind === "provider_binding" && version.retiredAtDbMs === undefined
    ));
    if (!liveVersion) throw new Error("expected live provider credential version");
    const { evidenceSha256: _evidence, ...versionBody } = liveVersion;
    const originalTargetEntries = [...store.tenantCredentialTargetDispositions.entries()].filter(
      ([, target]) => target.credentialVersionId === liveVersion.credentialVersionId,
    );
    for (const materialOverride of [
      { encryptedSecretPresent: false, secretKeyIdPresent: false },
      { customHeadersPresent: false },
      { endpointParametersPresent: false },
    ]) {
      const tamperedBody = { ...versionBody, ...materialOverride };
      const tamperedVersion = {
        ...tamperedBody,
        evidenceSha256: tenantCredentialVersionEvidenceSha256(tamperedBody),
      };
      store.tenantCredentialVersions.set(liveVersion.credentialVersionId, tamperedVersion);
      for (const [key, target] of originalTargetEntries) {
        const { evidenceSha256: _targetEvidence, ...targetBody } = target;
        const alignedTargetBody = {
          ...targetBody,
          disposition: tenantCredentialCurrentTargetDisposition(
            tamperedVersion,
            target.domain,
          ),
        };
        store.tenantCredentialTargetDispositions.set(key, {
          ...alignedTargetBody,
          evidenceSha256: tenantCredentialTargetDispositionEvidenceSha256(alignedTargetBody),
        });
      }
      await expect(store.getTenantCredentialInventorySnapshot(tenantId))
        .rejects.toBeInstanceOf(TenantErasureIntegrityError);
      for (const [key, target] of originalTargetEntries) {
        store.tenantCredentialTargetDispositions.set(key, structuredClone(target));
      }
    }

    const weakenedBody = { ...versionBody, customHeadersPresent: false };
    store.tenantCredentialVersions.set(liveVersion.credentialVersionId, {
      ...weakenedBody,
      evidenceSha256: tenantCredentialVersionEvidenceSha256(weakenedBody),
    });

    await expect(store.getTenantCredentialInventorySnapshot(tenantId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);

    const claim = await requestAndClaim(store, tenantId, 3_750);
    const beforeFailure = structuredClone({
      apiKeys: [...store.apiKeys.entries()],
      providers: [...store.providers.entries()],
      tenants: [...store.tenants.entries()],
      subjects: [...store.tenantCredentialTrackingSubjects.entries()],
      providerSlots: [...store.tenantCredentialProviderSlots.entries()],
      versions: [...store.tenantCredentialVersions.entries()],
      targets: [...store.tenantCredentialTargetDispositions.entries()],
      trackingCutovers: [...store.tenantCredentialTrackingCutovers.entries()],
      jobs: [...store.tenantCredentialRevocationJobs.entries()],
      revocationReceipts: [...store.tenantCredentialRevocationReceipts.entries()],
      inventoryReceipts: [...store.tenantCredentialInventoryReceipts.entries()],
      revocationCutovers: [...store.tenantCredentialRevocationCutovers.entries()],
    });
    await expect(store.revokeTenantCredentialMaterial(authorization(claim)))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(structuredClone({
      apiKeys: [...store.apiKeys.entries()],
      providers: [...store.providers.entries()],
      tenants: [...store.tenants.entries()],
      subjects: [...store.tenantCredentialTrackingSubjects.entries()],
      providerSlots: [...store.tenantCredentialProviderSlots.entries()],
      versions: [...store.tenantCredentialVersions.entries()],
      targets: [...store.tenantCredentialTargetDispositions.entries()],
      trackingCutovers: [...store.tenantCredentialTrackingCutovers.entries()],
      jobs: [...store.tenantCredentialRevocationJobs.entries()],
      revocationReceipts: [...store.tenantCredentialRevocationReceipts.entries()],
      inventoryReceipts: [...store.tenantCredentialInventoryReceipts.entries()],
      revocationCutovers: [...store.tenantCredentialRevocationCutovers.entries()],
    })).toEqual(beforeFailure);

    store.tenantCredentialVersions.set(
      liveVersion.credentialVersionId,
      structuredClone(liveVersion),
    );
    expect(await store.getTenantCredentialInventorySnapshot(tenantId)).toEqual(validSnapshot);
    await expect(store.revokeTenantCredentialMaterial(authorization(claim)))
      .resolves.toMatchObject({ tenantId, providerConfigCountBefore: 1 });
  });

  it("keeps cutover, first writes and later slot versions above a regressed clock", async () => {
    let nowMs = 10_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "credential-clock-high-water";
    await store.upsertProviderConfig(provider(tenantId, "legacy-provider", {
      headers: { Authorization: "legacy-header" },
    }));

    nowMs = 9_000;
    const cutover = await store.activateTenantCredentialTrackingCutover({
      expectedControlGeneration: 0,
    });
    expect(cutover.activatedAtDbMs).toBe(10_000);
    const activated = await store.getTenantCredentialInventorySnapshot(tenantId);
    expect(activated.subject.trackingStartedAtDbMs).toBe(10_000);
    expect(activated.providerSlots[0]?.updatedAtDbMs).toBe(10_000);
    expect(activated.versions[0]?.createdAtDbMs).toBe(10_000);
    expect(activated.targetDispositions.every((target) => target.capturedAtDbMs === 10_000))
      .toBe(true);

    nowMs = 8_000;
    await store.upsertProviderConfig(provider(tenantId, "legacy-provider", {
      headers: { Authorization: "managed-header" },
    }), undefined, 1);
    const replaced = await store.getTenantCredentialInventorySnapshot(tenantId);
    expect(replaced.providerSlots[0]?.updatedAtDbMs).toBe(10_001);
    expect(replaced.versions.find((version) => version.origin === "legacy_observed")?.retiredAtDbMs)
      .toBe(10_001);
    expect(replaced.versions.find((version) => (
      version.origin === "managed_v1" && version.retiredAtDbMs === undefined
    ))?.createdAtDbMs).toBe(10_001);

    nowMs = 7_000;
    await store.upsertProviderConfig(provider(tenantId, "new-provider", {
      headers: { Authorization: "new-provider-header" },
    }), undefined, null);
    const withNewSlot = await store.getTenantCredentialInventorySnapshot(tenantId);
    expect(withNewSlot.providerSlots.find((slot) => slot.writeGeneration === 1)?.updatedAtDbMs)
      .toBeGreaterThanOrEqual(10_001);
    expect(Math.min(...withNewSlot.versions.map((version) => version.createdAtDbMs)))
      .toBeGreaterThanOrEqual(cutover.activatedAtDbMs!);

    nowMs = 6_000;
    await store.setTenantAuth(tenantId, AUTH_POLICY, {
      ciphertext: Buffer.from("clock-auth-secret"),
      keyId: "clock-auth-key",
    }, 0);
    const withAuth = await store.getTenantCredentialInventorySnapshot(tenantId);
    expect(withAuth.authSlot.updatedAtDbMs).toBeGreaterThanOrEqual(10_001);
    expect(withAuth.versions.every((version) => (
      version.createdAtDbMs >= cutover.activatedAtDbMs!
      && (version.retiredAtDbMs === undefined
        || version.retiredAtDbMs >= version.createdAtDbMs)
    ))).toBe(true);
    expect(withAuth.targetDispositions.every((target) => {
      const version = withAuth.versions.find((item) => (
        item.credentialVersionId === target.credentialVersionId
      ));
      return target.capturedAtDbMs === version?.createdAtDbMs;
    })).toBe(true);
  });

  it("does not let a regressed wall clock extend T3a authority past the ledger high-water", async () => {
    let nowMs = 20_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
    const tenantId = "credential-clock-expired-claim";
    await store.upsertProviderConfig(provider(tenantId, "provider", {
      headers: { Authorization: "credential-header" },
    }), undefined, null);
    nowMs += 1;
    await store.upsertProviderConfig(provider(tenantId, "provider", {
      headers: { Authorization: "credential-header-v2" },
    }), undefined, 1);
    const before = await store.getTenantCredentialInventorySnapshot(tenantId);

    nowMs = 19_000;
    const claim = await requestAndClaim(store, tenantId, nowMs);
    expect(claim.leaseUntilMs).toBe(20_000);
    expect(await store.revokeTenantCredentialMaterial(authorization(claim))).toBeNull();
    expect(await store.getTenantCredentialInventorySnapshot(tenantId)).toEqual(before);
    expect(await store.getTenantCredentialRevocationReceipt(tenantId, claim.requestId)).toBeNull();
    expect(await store.getTenantCredentialRevocationJob(tenantId, claim.requestId))
      .toMatchObject({ phase: "queued", claimToken: claim.claimToken });
  });

  it("rolls activation and write publication back on serialization or late map failure", async () => {
    const store = new MemorySessionStore({ now: () => 4_000 });
    await store.upsertProviderConfig(provider("rollback-tenant", "rollback-provider", {
      apiKeyRef: "secret:rollback-provider",
    }), {
      ciphertext: Buffer.from("rollback-secret"),
      keyId: "rollback-key",
    });
    const row = [...store.providers.values()][0]!;
    (row.config as ProviderConfig & { uncloneable?: () => void }).uncloneable = () => {};
    await expect(store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 }))
      .rejects.toBeDefined();
    expect(await store.readTenantCredentialTrackingCutover())
      .toEqual({ controlGeneration: 0 });
    expect(store.tenantCredentialTrackingSubjects).toHaveLength(0);
    expect(store.tenantCredentialVersions).toHaveLength(0);
    expect(store.tenantCredentialTargetDispositions).toHaveLength(0);
    delete (row.config as ProviderConfig & { uncloneable?: () => void }).uncloneable;

    const cutovers = store.tenantCredentialTrackingCutovers;
    const originalCutoverSet = cutovers.set;
    cutovers.set = function injected(key, value) {
      originalCutoverSet.call(this, key, value);
      throw new Error("injected tracking cutover publication failure");
    };
    await expect(store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 }))
      .rejects.toThrow("injected tracking cutover publication failure");
    delete (cutovers as unknown as { set?: unknown }).set;
    expect(await store.readTenantCredentialTrackingCutover())
      .toEqual({ controlGeneration: 0 });
    expect(store.tenantCredentialTrackingSubjects).toHaveLength(0);
    expect(store.tenantCredentialVersions).toHaveLength(0);
    expect(store.tenantCredentialTargetDispositions).toHaveLength(0);
    expect((await store.getProviderConfig("rollback-tenant", "rollback-provider"))
      ?.secret?.ciphertext.toString()).toBe("rollback-secret");

    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
    const beforeSnapshot = await store.getTenantCredentialInventorySnapshot("rollback-tenant");
    const beforeProvider = await store.getProviderConfig("rollback-tenant", "rollback-provider");
    const versions = store.tenantCredentialVersions;
    const originalSet = versions.set;
    versions.set = function injected(key, value) {
      originalSet.call(this, key, value);
      throw new Error("injected credential version publication failure");
    };
    await expect(store.upsertProviderConfig(
      provider("rollback-tenant", "rollback-provider", {
        headers: { Authorization: "new-header" },
        apiKeyRef: "secret:rollback-provider",
      }),
      undefined,
      1,
    )).rejects.toThrow("injected credential version publication failure");
    delete (versions as unknown as { set?: unknown }).set;
    expect(await store.getTenantCredentialInventorySnapshot("rollback-tenant"))
      .toEqual(beforeSnapshot);
    expect(await store.getProviderConfig("rollback-tenant", "rollback-provider"))
      .toEqual(beforeProvider);
  });

  it("publishes T3a deletion and its complete inventory receipt atomically", async () => {
    let nowMs = 5_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
    const tenantId = "t3a-target";
    const neighborId = "t3a-neighbor";
    await store.setTenantAuth(tenantId, AUTH_POLICY, {
      ciphertext: Buffer.from("target-auth-secret"),
      keyId: "target-auth-key",
    }, null);
    await store.createApiKey(tenantId, "target-key", "target-key-hash");
    await store.upsertProviderConfig(
      provider(tenantId, "credential-provider", {
        headers: { Authorization: "target-provider-header" },
        apiKeyRef: "secret:target-provider",
      }),
      { ciphertext: Buffer.from("target-provider-secret"), keyId: "target-provider-key" },
      null,
    );
    await store.upsertProviderConfig(provider(tenantId, "keyless-provider"), undefined, null);
    nowMs += 1;
    await store.upsertProviderConfig(
      provider(tenantId, "credential-provider", {
        headers: { Authorization: "target-provider-header-v2" },
        apiKeyRef: "secret:target-provider",
      }),
      undefined,
      1,
    );
    await store.setTenantAuth(neighborId, AUTH_POLICY, {
      ciphertext: Buffer.from("neighbor-auth-secret"),
      keyId: "neighbor-auth-key",
    }, null);
    await store.upsertProviderConfig(
      provider(neighborId, "neighbor-provider", {
        headers: { Authorization: "neighbor-provider-header" },
      }),
      undefined,
      null,
    );

    const targetBefore = await store.getTenantCredentialInventorySnapshot(tenantId);
    const neighborBefore = await store.getTenantCredentialInventorySnapshot(neighborId);
    const claim = await requestAndClaim(store, tenantId, nowMs);
    const stateBeforeFailure = structuredClone({
      providers: [...store.providers.entries()],
      tenant: store.tenants.get(tenantId),
      slots: [...store.tenantCredentialProviderSlots.entries()],
      versions: [...store.tenantCredentialVersions.entries()],
      job: store.tenantCredentialRevocationJobs.get(claim.requestId),
    });
    const inventoryReceipts = store.tenantCredentialInventoryReceipts;
    const originalSet = inventoryReceipts.set;
    inventoryReceipts.set = function injected(key, value) {
      originalSet.call(this, key, value);
      throw new Error("injected inventory receipt publication failure");
    };
    nowMs += 1;
    await expect(store.revokeTenantCredentialMaterial(authorization(claim)))
      .rejects.toThrow("injected inventory receipt publication failure");
    delete (inventoryReceipts as unknown as { set?: unknown }).set;
    expect(structuredClone({
      providers: [...store.providers.entries()],
      tenant: store.tenants.get(tenantId),
      slots: [...store.tenantCredentialProviderSlots.entries()],
      versions: [...store.tenantCredentialVersions.entries()],
      job: store.tenantCredentialRevocationJobs.get(claim.requestId),
    })).toEqual(stateBeforeFailure);
    expect(await store.getTenantCredentialInventorySnapshot(tenantId)).toEqual(targetBefore);
    expect(store.tenantCredentialRevocationReceipts).toHaveLength(0);
    expect(store.tenantCredentialInventoryReceipts).toHaveLength(0);

    const t3aReceipt = await store.revokeTenantCredentialMaterial(authorization(claim));
    expect(t3aReceipt).toMatchObject({
      tenantId,
      providerConfigCountBefore: 2,
      providerConfigCountAfter: 0,
    });
    const inventory = await store.getTenantCredentialInventoryReceipt(
      tenantId,
      claim.requestId,
    );
    const targetAfter = await store.getTenantCredentialInventorySnapshot(tenantId);
    expect(inventory).toMatchObject({
      t3aReceiptSha256: t3aReceipt?.receiptSha256,
      subjectCount: 1,
      providerSlotCount: 2,
      authSlotCount: 1,
      providerSourceCountBefore: 1,
      providerSourcePointerCountBefore: 1,
      authSecretPresentBefore: true,
      authSourcePointerPresentBefore: true,
      legacyHistoryUnknownSubjectCount: 0,
      subjectRootSha256: targetAfter.subjectRootSha256,
      providerSlotRootSha256: targetAfter.providerSlotRootSha256,
      authSlotRootSha256: targetAfter.authSlotRootSha256,
      versionRootSha256: targetAfter.versionRootSha256,
      targetDispositionRootSha256: targetAfter.targetDispositionRootSha256,
    });
    expect(targetAfter.providerSlots.every((slot) => !slot.sourcePresent)).toBe(true);
    expect(targetAfter.authSlot.sourcePresent).toBe(false);
    expect(targetAfter.versions.every((version) => version.retiredAtDbMs !== undefined)).toBe(true);
    expect(targetAfter.versions.filter((version) => version.retireReason === "tenant_erasure"))
      .toHaveLength(2);
    expect(await store.getTenantCredentialInventoryReceipt(neighborId, claim.requestId))
      .toBeNull();
    expect(await store.getTenantCredentialInventorySnapshot(neighborId)).toEqual(neighborBefore);
    expect(await store.revokeTenantCredentialMaterial(authorization(claim))).toEqual(t3aReceipt);
  });
});
