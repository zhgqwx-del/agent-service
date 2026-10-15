import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tenantRuntimeFleetSha256, tenantRuntimeLocalReceiptSha256, tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256, type ProviderConfig } from "@agent-service/protocol";
import { MemorySessionStore, CredentialSourceConflictError, TenantErasureIntegrityError,
  TenantCredentialResponsibilityIntegrityError, createProviderByokSecretAdmission,
  newErasureRequestId, tenantErasureRequestHash, tenantCredentialSlotIdSha256,
  type TenantCredentialRevocationClaim } from "../src/index.js";

// Real MemoryStore mutation/claim/T3a/T3b consumers. The closed fleet proof is
// a non-network protocol fixture, not vendor revocation or memory zeroization.
const sha = (label: string) => createHash("sha256").update(label).digest("hex");
function provider(tenantId = "byok-responsibility", patch: Partial<ProviderConfig> = {}): ProviderConfig {
  return { tenantId, id: "provider", api: "openai-completions", baseUrl: "https://example.invalid/v1",
    apiKeyRef: "secret:memory-byok", headers: {}, models: [{ id: "model", contextWindow: 1_000,
      maxOutputTokens: 10, input: ["text"], reasoning: false }], quota: {}, fallback: [],
    createdAtMs: 1, updatedAtMs: 1, ...patch };
}
function secret(label = "new") { return { ciphertext: Buffer.from(`encrypted-memory-fixture-${label}`), keyId: "platform-shared-key" }; }
async function fixture(active = true) {
  let now = 1_000;
  const store = new MemorySessionStore({ now: () => now });
  if (active) await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
  return { store, tick() { now += 100; return now; }, now: () => now };
}
async function write(store: MemorySessionStore, config: ProviderConfig, expectedSourceRevision: number | null,
  encrypted = secret()) {
  const admission = createProviderByokSecretAdmission({ tenantId: config.tenantId, providerId: config.id,
    expectedSourceRevision, secret: encrypted });
  return store.upsertProviderConfigWithResponsibility({ config, expectedSourceRevision,
    secret: encrypted, secretAdmission: admission });
}
function credentialAuth(claim: TenantCredentialRevocationClaim) {
  return { requestId: claim.requestId, tenantId: claim.tenantId, subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
}
async function request(f: Awaited<ReturnType<typeof fixture>>, tenantId = "byok-responsibility") {
  const input = { tenantId, requestId: newErasureRequestId(), requestedByKeyId: "responsibility-test",
    idempotencyKey: `responsibility-${randomUUID()}`, requestHash: tenantErasureRequestHash(tenantId), atMs: f.tick() };
  await f.store.requestTenantErasure(input);
  const claim = (await f.store.claimTenantCredentialRevocations({ limit: 10, leaseMs: 120_000,
    claimToken: `responsibility-${randomUUID()}` })).find((row) => row.requestId === input.requestId);
  if (!claim) throw new Error("missing real T3a claim");
  return { input, claim, auth: credentialAuth(claim) };
}
async function completeRuntime(f: Awaited<ReturnType<typeof fixture>>, requestId: string) {
  expect(await f.store.materializeTenantRuntimeRevocationJobs({ limit: 10 })).toBe(1);
  const claim = (await f.store.claimTenantRuntimeRevocations({ limit: 10, leaseMs: 120_000,
    claimToken: `runtime-${randomUUID()}` })).find((row) => row.requestId === requestId);
  if (!claim) throw new Error("missing real T3b claim");
  const body = { targetSha256: tenantRuntimeTargetSha256("http://runner.invalid:8080"), runnerId: "runner",
    bootId: "boot", requestId: claim.requestId, tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration, t3aReceiptSha256: claim.t3aReceiptSha256,
    cacheEntryCountBefore: 1, cacheEntryCountAfter: 0 as const, activeOperationCountBefore: 0,
    activeOperationCountAfter: 0 as const, activeTurnCountBefore: 0, activeTurnCountAfter: 0 as const,
    completedAtMs: f.tick() };
  const targets = [{ ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) }];
  const receipt = await f.store.completeTenantRuntimeRevocation({ requestId, tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration, claimAttempt: claim.claimAttempt, claimToken: claim.claimToken },
  { targets, fleetSha256: tenantRuntimeFleetSha256(targets), targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets) });
  expect(receipt).not.toBeNull(); return receipt!;
}
function maps(store: MemorySessionStore) {
  return { providers: [...store.providers], slots: [...store.tenantCredentialProviderSlots],
    versions: [...store.tenantCredentialVersions], targets: [...store.tenantCredentialTargetDispositions],
    sources: [...store.tenantCredentialResponsibilitySources], tenants: [...store.tenants],
    jobs: [...store.tenantCredentialRevocationJobs], receipts: [...store.tenantCredentialRevocationReceipts],
    inventories: [...store.tenantCredentialInventoryReceipts],
    entries: [...store.tenantCredentialResponsibilitySnapshotEntries],
    snapshots: [...store.tenantCredentialResponsibilitySnapshotReceipts] };
}
afterEach(() => vi.restoreAllMocks());

describe("Memory BYOK responsibility actual consumers", () => {
  it("atomically captures a new secret/version then consumes actual T1/T3a/T3b without granting completion", async () => {
    const f = await fixture(); await write(f.store, provider(), null);
    const initial = [...f.store.tenantCredentialResponsibilitySources.values()];
    expect(initial).toHaveLength(1); expect(initial[0]).toMatchObject({ apiKeySource: "new_byok",
      apiKeyResponsibility: "customer_managed", envelopeKeyResponsibility: "platform_shared_not_tenant_deletable" });
    const r = await request(f);
    expect(await f.store.getTenantCredentialResponsibilityReadiness(r.input.tenantId, r.input.requestId))
      .toMatchObject({ status: "unknown", localDatabase: "not_cleared", versionCount: null });
    f.tick();
    const t3a = await f.store.revokeTenantCredentialMaterial(r.auth);
    expect(t3a).not.toBeNull();
    expect(await f.store.getProviderConfig(r.input.tenantId, "provider")).toBeNull();
    expect(await f.store.getTenantCredentialResponsibilityReadiness(r.input.tenantId, r.input.requestId))
      .toMatchObject({ status: "awaiting_runtime_drain", localDatabase: "cleared", trackedRuntimeReferences: "not_drained",
        versionCount: 1, customerManagedApiKeyCount: 1, unknownMaterialCount: 0 });
    const t3b = await completeRuntime(f, r.input.requestId);
    expect(await f.store.getTenantCredentialResponsibilityReadiness(r.input.tenantId, r.input.requestId))
      .toMatchObject({ status: "local_responsibility_observed", localDatabase: "cleared",
        trackedRuntimeReferences: "dropped_not_zeroized", remoteCredentials: "customer_responsibility_recorded",
        t3aReceiptSha256: t3a!.receiptSha256, t3bReceiptSha256: t3b.receiptSha256,
        sharedKeys: "platform_shared_not_tenant_deletable", backupCopies: "unknown", otherCopies: "unknown",
        executionReady: false, externalAuthorityVerified: false, allDomainsComplete: false, contentPurgeExecuted: false });
    expect([...f.store.tenantCredentialResponsibilitySources.values()]).toEqual(initial);
    expect(await f.store.revokeTenantCredentialMaterial(r.auth)).toEqual(t3a);
  });

  it("inherits an exact admitted envelope across a config-only edit without upgrading header/endpoint materials", async () => {
    const f = await fixture(); const config = provider(); await write(f.store, config, null);
    const before = [...f.store.tenantCredentialResponsibilitySources.values()][0]!;
    f.tick();
    await f.store.upsertProviderConfigWithResponsibility({ config: { ...config, headers: { "x-secret": "private-header" },
      baseUrl: "https://example.invalid/v1?private=endpoint" }, expectedSourceRevision: 1 });
    const current = [...f.store.tenantCredentialResponsibilitySources.values()].find((row) => row.sourceRevision === 2)!;
    expect(current).toMatchObject({ apiKeySource: "inherited_byok", apiKeyResponsibility: "customer_managed",
      inheritedFromCredentialVersionId: before.credentialVersionId,
      inheritedFromResponsibilityReceiptSha256: before.receiptSha256,
      secretEnvelopeSha256: before.secretEnvelopeSha256,
      customHeadersResponsibility: "unknown", endpointParametersResponsibility: "unknown" });
    const r = await request(f); f.tick(); await f.store.revokeTenantCredentialMaterial(r.auth);
    expect(await f.store.getTenantCredentialResponsibilityReadiness(r.input.tenantId, r.input.requestId))
      .toMatchObject({ status: "unknown", localDatabase: "cleared", unknownMaterialCount: 2, remoteCredentials: "unknown" });
  });

  it("does not promote legacy ciphertext when managed_v1 is produced by a later config edit", async () => {
    const f = await fixture(false), config = provider();
    await f.store.upsertProviderConfig(config, secret("legacy"));
    f.tick(); await f.store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
    f.tick(); await f.store.upsertProviderConfigWithResponsibility({ config: { ...config, updatedAtMs: 2 }, expectedSourceRevision: 1 });
    const sidecar = [...f.store.tenantCredentialResponsibilitySources.values()][0]!;
    expect(sidecar).toMatchObject({ apiKeySource: "unknown", apiKeyResponsibility: "unknown", newSecretAdmissionSha256: null });
    expect(f.store.tenantCredentialVersions.get(sidecar.credentialVersionId)?.origin).toBe("managed_v1");
    const r = await request(f); f.tick(); await f.store.revokeTenantCredentialMaterial(r.auth);
    expect(await f.store.getTenantCredentialResponsibilityReadiness(r.input.tenantId, r.input.requestId))
      .toMatchObject({ status: "unknown", remoteCredentials: "unknown", unknownMaterialCount: 2 });
  });

  it("preserves inactive ordinary BYOK CRUD but emits no responsibility or fake empty snapshot", async () => {
    const f = await fixture(false); await write(f.store, provider(), null);
    expect((await f.store.getProviderConfig("byok-responsibility", "provider"))?.secret?.keyId).toBe("platform-shared-key");
    expect(f.store.tenantCredentialResponsibilitySources.size).toBe(0);
    const r = await request(f); f.tick(); await f.store.revokeTenantCredentialMaterial(r.auth);
    expect(f.store.tenantCredentialResponsibilitySnapshotReceipts.size).toBe(0);
    expect(await f.store.getTenantCredentialResponsibilityReadiness(r.input.tenantId, r.input.requestId))
      .toMatchObject({ status: "unknown", localDatabase: "cleared", versionCount: null, responsibilityReceiptSha256: null });
  });

  it("refuses a cloned/literal admission or copied secret before any publication", async () => {
    const f = await fixture(), config = provider(), encrypted = secret();
    const token = createProviderByokSecretAdmission({ tenantId: config.tenantId, providerId: config.id,
      expectedSourceRevision: null, secret: encrypted });
    const before = maps(f.store);
    for (const input of [
      { config, secret: encrypted, expectedSourceRevision: null, secretAdmission: Object.freeze({ kind: token.kind }) },
      { config, secret: encrypted, expectedSourceRevision: null, secretAdmission: structuredClone(token) },
      { config, secret: { ciphertext: Buffer.from(encrypted.ciphertext), keyId: encrypted.keyId }, expectedSourceRevision: null, secretAdmission: token },
    ]) {
      await expect(f.store.upsertProviderConfigWithResponsibility(input)).rejects.toBeInstanceOf(TenantCredentialResponsibilityIntegrityError);
      expect(maps(f.store)).toEqual(before);
    }
  });

  it("has exactly one CAS winner across concurrent original-object admissions", async () => {
    const f = await fixture();
    const settled = await Promise.allSettled([write(f.store, provider(), null, secret("a")), write(f.store, provider(), null, secret("b"))]);
    expect(settled.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((row) => row.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expect(rejected.reason).toBeInstanceOf(CredentialSourceConflictError);
    expect(f.store.tenantCredentialResponsibilitySources.size).toBe(1);
    expect(f.store.tenantCredentialVersions.size).toBe(1);
    expect((await f.store.getProviderConfig("byok-responsibility", "provider"))?.credentialSourceRevision).toBe(1);
  });

  it("rolls provider/version/CAS back with a late responsibility-source publication failure", async () => {
    const f = await fixture(), before = maps(f.store);
    const original = f.store.tenantCredentialResponsibilitySources.set.bind(f.store.tenantCredentialResponsibilitySources);
    vi.spyOn(f.store.tenantCredentialResponsibilitySources, "set").mockImplementationOnce((id, row) => {
      original(id, row); throw new Error("isolated source publication failure");
    });
    await expect(write(f.store, provider(), null)).rejects.toThrow("isolated source publication failure");
    expect(maps(f.store)).toEqual(before);
  });

  it("rolls actual T3a deletion and all old/new receipts back after a late snapshot failure", async () => {
    const f = await fixture(); await write(f.store, provider(), null);
    const r = await request(f), before = maps(f.store); f.tick();
    const original = f.store.tenantCredentialResponsibilitySnapshotReceipts.set.bind(f.store.tenantCredentialResponsibilitySnapshotReceipts);
    vi.spyOn(f.store.tenantCredentialResponsibilitySnapshotReceipts, "set").mockImplementationOnce((id, row) => {
      original(id, row); throw new Error("isolated snapshot publication failure");
    });
    await expect(f.store.revokeTenantCredentialMaterial(r.auth)).rejects.toThrow("isolated snapshot publication failure");
    expect(maps(f.store)).toEqual(before);
    expect(f.store.providers.size).toBe(1);
    expect(f.store.tenantCredentialRevocationJobs.get(r.input.requestId)?.phase).toBe("queued");
  });

  it("preserves trusted target reference and does not convert it into customer remote responsibility", async () => {
    const f = await fixture(), config = provider(), encrypted = secret(), targetCipher = Buffer.from("opaque-target-cipher");
    const token = createProviderByokSecretAdmission({ tenantId: config.tenantId, providerId: config.id,
      expectedSourceRevision: null, secret: encrypted });
    await f.store.upsertProviderConfigWithResponsibility({ config, secret: encrypted, secretAdmission: token,
      expectedSourceRevision: null, targetReference: { domain: "external_credential", disposition: "executable_ref",
        adapterProtocol: "provider-target-v1", targetReferenceCipher: targetCipher, targetReferenceKeyId: "locator-key",
        targetReferenceCipherSha256: createHash("sha256").update(targetCipher).digest("hex"), targetReferenceSha256: sha("opaque-locator") } });
    expect([...f.store.tenantCredentialResponsibilitySources.values()][0]?.apiKeyResponsibility).toBe("unknown");
    expect([...f.store.tenantCredentialTargetDispositions.values()].find((row) => row.domain === "external_credential")?.disposition).toBe("executable_ref");
    const r = await request(f); f.tick(); await f.store.revokeTenantCredentialMaterial(r.auth);
    expect(await f.store.getTenantCredentialResponsibilityReadiness(r.input.tenantId, r.input.requestId))
      .toMatchObject({ status: "unknown", remoteCredentials: "unknown", unknownMaterialCount: 1 });
  });

  it("keeps missing historical snapshot unknown on exact replay, but rejects a partial snapshot", async () => {
    const f = await fixture(); await write(f.store, provider(), null);
    const r = await request(f); f.tick(); const receipt = await f.store.revokeTenantCredentialMaterial(r.auth);
    f.store.tenantCredentialResponsibilitySnapshotReceipts.delete(r.input.requestId);
    await expect(f.store.getTenantCredentialResponsibilityReadiness(r.input.tenantId, r.input.requestId))
      .rejects.toBeInstanceOf(TenantCredentialResponsibilityIntegrityError);
    f.store.tenantCredentialResponsibilitySnapshotEntries.delete(r.input.requestId);
    expect(await f.store.revokeTenantCredentialMaterial(r.auth)).toEqual(receipt);
    expect(await f.store.getTenantCredentialResponsibilityReadiness(r.input.tenantId, r.input.requestId))
      .toMatchObject({ status: "unknown", versionCount: null, responsibilityReceiptSha256: null });
    expect(f.store.tenantCredentialResponsibilitySnapshotReceipts.size).toBe(0);
  });

  it("rejects a lost inherited predecessor before local deletion, not by trusting its receipt hash", async () => {
    const f = await fixture(), config = provider(); await write(f.store, config, null); f.tick();
    await f.store.upsertProviderConfigWithResponsibility({ config, expectedSourceRevision: 1 });
    const original = [...f.store.tenantCredentialResponsibilitySources.values()].find((row) => row.sourceRevision === 1)!;
    f.store.tenantCredentialResponsibilitySources.delete(original.credentialVersionId);
    const r = await request(f), before = maps(f.store); f.tick();
    await expect(f.store.revokeTenantCredentialMaterial(r.auth)).rejects.toBeInstanceOf(TenantCredentialResponsibilityIntegrityError);
    expect(maps(f.store)).toEqual(before);
  });

  it("seals explicit empty only from a real complete tracking inventory and hides foreign tenants", async () => {
    const f = await fixture();
    await f.store.createApiKey("empty-complete", "empty-key", sha("empty-key"));
    await write(f.store, provider("neighbor"), null);
    const neighborBefore = await f.store.getProviderConfig("neighbor", "provider");
    const r = await request(f, "empty-complete"); f.tick(); await f.store.revokeTenantCredentialMaterial(r.auth);
    expect(f.store.tenantCredentialResponsibilitySnapshotEntries.get(r.input.requestId)).toEqual([]);
    expect(await f.store.getTenantCredentialResponsibilityReadiness("empty-complete", r.input.requestId))
      .toMatchObject({ versionCount: 0, unknownMaterialCount: 0, remoteCredentials: "not_applicable", allDomainsComplete: false });
    expect(await f.store.getTenantCredentialResponsibilityReadiness("neighbor", r.input.requestId)).toBeNull();
    expect(await f.store.getProviderConfig("neighbor", "provider")).toEqual(neighborBefore);
    expect(f.store.tenantCredentialProviderSlots.get(tenantCredentialSlotIdSha256("neighbor", "provider_binding", "provider"))?.sourcePresent).toBe(true);
  });

  it("does not present a repopulated local credential as cleared merely because an old receipt exists", async () => {
    const f = await fixture(); await write(f.store, provider(), null);
    const saved = [...f.store.providers.entries()][0]!;
    const r = await request(f); f.tick(); await f.store.revokeTenantCredentialMaterial(r.auth);
    // Deliberate privileged Memory tamper, not a normal post-T1 write capability.
    f.store.providers.set(saved[0], saved[1]);
    await expect(f.store.getTenantCredentialResponsibilityReadiness(r.input.tenantId, r.input.requestId))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
  });
});
