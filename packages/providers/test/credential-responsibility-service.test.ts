import { describe, expect, it, vi } from "vitest";
import {
  CredentialSourceConflictError,
  SubjectDeletingError,
  TenantCredentialResponsibilityIntegrityError,
} from "@agent-service/store";
import type { ProviderConfigInput } from "@agent-service/protocol";
import { ProviderService } from "../src/index.js";
import { credentialResponsibilityFixture, responsibilityProvider } from "./credential-responsibility.fixture.js";

describe("ProviderService actual BYOK responsibility admission", () => {
  it("uses the original encrypted envelope, then consumes actual T3a/T3b without vendor calls or shared-key deletion", async () => {
    const outbound = vi.fn<typeof fetch>(async () => { throw new Error("unexpected fixture outbound call"); });
    const f = await credentialResponsibilityFixture({ fetch: outbound });
    const write = vi.spyOn(f.store, "upsertProviderConfigWithResponsibility");
    const encrypt = vi.spyOn(f.cipher, "encrypt");
    await f.providers.upsertTenantProvider(f.tenantId, responsibilityProvider());
    expect(encrypt).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    const input = write.mock.calls[0]![0];
    expect(input.expectedSourceRevision).toBeNull();
    expect(Object.isFrozen(input.secretAdmission)).toBe(true);
    expect(input.secret?.ciphertext).toEqual(await encrypt.mock.results[0]!.value);
    expect(JSON.stringify(input.config)).not.toContain("responsibility-fixture-customer-key");

    await f.providers.upsertTenantProvider("responsibility-neighbor", responsibilityProvider({ apiKey: "neighbor-key" }));
    const neighborBefore = await f.store.getProviderConfig("responsibility-neighbor", "byok");
    const oldModel = await f.providers.resolve({ tenantId: f.tenantId, userId: "user" }, { provider: "byok", model: "model" });
    expect(await oldModel.apiKey()).toBe("responsibility-fixture-customer-key");
    const request = await f.admit();
    const t3a = await f.clearLocal();
    const beforeDrain = await f.store.getTenantCredentialResponsibilityReadiness(f.tenantId, request.requestId);
    expect(beforeDrain).toMatchObject({ status: "awaiting_runtime_drain", localDatabase: "cleared",
      trackedRuntimeReferences: "not_drained", t3aReceiptSha256: t3a.receiptSha256 });
    const t3b = await f.drainRuntime();
    const result = await f.store.getTenantCredentialResponsibilityReadiness(f.tenantId, request.requestId);
    expect(result).toMatchObject({ status: "local_responsibility_observed", localDatabase: "cleared",
      trackedRuntimeReferences: "dropped_not_zeroized", remoteCredentials: "customer_responsibility_recorded",
      versionCount: 1, customerManagedApiKeyCount: 1, unknownMaterialCount: 0,
      t3aReceiptSha256: t3a.receiptSha256, t3bReceiptSha256: t3b.receiptSha256,
      sharedKeys: "platform_shared_not_tenant_deletable", backupCopies: "unknown", otherCopies: "unknown",
      executionReady: false, externalAuthorityVerified: false, allDomainsComplete: false, contentPurgeExecuted: false });
    expect(result?.responsibilityReceiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await f.store.getProviderConfig("responsibility-neighbor", "byok")).toEqual(neighborBefore);
    const neighbor = await f.providers.resolve({ tenantId: "responsibility-neighbor", userId: "user" }, { provider: "byok", model: "model" });
    const platform = await f.providers.resolve({ tenantId: "responsibility-neighbor", userId: "user" }, { provider: "dashscope", model: "qwen-plus" });
    expect(await neighbor.apiKey()).toBe("neighbor-key");
    expect(await platform.apiKey()).toBe("responsibility-fixture-platform-key");
    await expect(oldModel.apiKey()).rejects.toBeInstanceOf(SubjectDeletingError);
    expect(f.cipher.keyId).toBe("shared-fixture-master");
    expect(outbound).not.toHaveBeenCalled();
    expect(await f.store.getTenantCredentialResponsibilityReadiness("responsibility-neighbor", request.requestId)).toBeNull();
  });

  it("reissues an admission for each real CAS retry and rejects cloned/literal or rebound admissions", async () => {
    const f = await credentialResponsibilityFixture();
    await f.providers.upsertTenantProvider(f.tenantId, responsibilityProvider({ apiKey: "old-key" }));
    const delegate = f.store.upsertProviderConfigWithResponsibility.bind(f.store);
    const legacyWrite = f.store.upsertProviderConfig.bind(f.store);
    let raced = false;
    const write = vi.spyOn(f.store, "upsertProviderConfigWithResponsibility").mockImplementation(async (input) => {
      if (!raced) {
        raced = true;
        await expect(delegate({ ...input, secretAdmission: structuredClone(input.secretAdmission) }))
          .rejects.toBeInstanceOf(TenantCredentialResponsibilityIntegrityError);
        await legacyWrite({ ...input.config, name: "actual concurrent write" }, undefined, input.expectedSourceRevision);
        throw new CredentialSourceConflictError("provider", input.expectedSourceRevision,
          (await f.store.getProviderConfig(f.tenantId, "byok"))!.credentialSourceRevision);
      }
      return delegate(input);
    });
    await f.providers.upsertTenantProvider(f.tenantId, responsibilityProvider({ apiKey: "replacement-key" }));
    expect(raced).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    const first = write.mock.calls[0]![0], second = write.mock.calls[1]![0];
    expect(first.expectedSourceRevision).toBe(1);
    expect(second.expectedSourceRevision).toBe(2);
    expect(first.secretAdmission).not.toBe(second.secretAdmission);
    expect(first.secret).toBe(second.secret);
    expect(Object.isFrozen(first.secretAdmission)).toBe(true);
    expect(Object.isFrozen(second.secretAdmission)).toBe(true);
    for (const changed of [
      { ...second, secretAdmission: { ...second.secretAdmission! } },
      { ...second, secret: { ciphertext: Buffer.from(second.secret!.ciphertext), keyId: second.secret!.keyId } },
      { ...second, config: { ...second.config, tenantId: "responsibility-neighbor" } },
      { ...second, config: { ...second.config, id: "other-provider" } },
      { ...second, expectedSourceRevision: 999 },
      { ...second, secretAdmission: undefined },
    ]) {
      await expect(delegate(changed)).rejects.toBeInstanceOf(TenantCredentialResponsibilityIntegrityError);
    }
    const model = await f.providers.resolve({ tenantId: f.tenantId, userId: "user" }, { provider: "byok", model: "model" });
    expect(await model.apiKey()).toBe("replacement-key");
  });

  it("does not upgrade an inherited legacy key when a caller adds responsibility labels to config-only input", async () => {
    const f = await credentialResponsibilityFixture();
    const raw = responsibilityProvider();
    const { apiKey, ...config } = raw;
    await f.store.upsertProviderConfig({ ...config, tenantId: f.tenantId, apiKeyRef: "legacy-ref",
      createdAtMs: Date.now(), updatedAtMs: Date.now() }, {
      ciphertext: await f.cipher.encrypt(apiKey!), keyId: f.cipher.keyId,
    }, null);
    const write = vi.spyOn(f.store, "upsertProviderConfigWithResponsibility");
    const forgedLabels = { ...raw, apiKey: undefined, isBYOK: true,
      responsibility: "customer", secretAdmission: Object.freeze({}) } as ProviderConfigInput;
    await f.providers.upsertTenantProvider(f.tenantId, forgedLabels);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![0]).not.toHaveProperty("secret");
    expect(write.mock.calls[0]![0]).not.toHaveProperty("secretAdmission");
    expect(write.mock.calls[0]![0].config).not.toHaveProperty("isBYOK");
    expect(write.mock.calls[0]![0].config).not.toHaveProperty("responsibility");
    const request = await f.admit();
    await f.clearLocal(); await f.drainRuntime();
    const result = await f.store.getTenantCredentialResponsibilityReadiness(f.tenantId, request.requestId);
    expect(result).toMatchObject({ status: "unknown", remoteCredentials: "unknown", customerManagedApiKeyCount: 0,
      localDatabase: "cleared", trackedRuntimeReferences: "dropped_not_zeroized", allDomainsComplete: false });
    expect(result!.unknownMaterialCount).toBeGreaterThan(0);
  });

  it("does not promote header/endpoint credentials just because the same write contains a new BYOK key", async () => {
    const f = await credentialResponsibilityFixture();
    await f.providers.upsertTenantProvider(f.tenantId, responsibilityProvider({
      headers: { "X-Private-Credential": "header-key" }, baseUrl: "https://provider.example/v1?credential=query-key",
    }));
    const request = await f.admit();
    await f.clearLocal(); await f.drainRuntime();
    const result = await f.store.getTenantCredentialResponsibilityReadiness(f.tenantId, request.requestId);
    expect(result).toMatchObject({ status: "unknown", remoteCredentials: "unknown", allDomainsComplete: false });
    expect(result!.unknownMaterialCount).toBeGreaterThan(0);
  });

  it("keeps a trusted management target executable rather than exempting it as customer-owned", async () => {
    const f = await credentialResponsibilityFixture();
    const capture = vi.fn(async () => ({ adapterProtocol: "managed-fixture-target-v1",
      opaqueReference: Buffer.from("server-owned-management-slot") }));
    const service = new ProviderService({ store: f.store, cipher: f.cipher,
      assertBaseUrl: async () => {}, credentialTargetReferenceFactory: { capture },
      credentialTargetReferenceProtector: { protect: async (input) => ({
        ciphertext: Buffer.concat([Buffer.from("protected:"), input]), keyId: "independent-reference-key",
      }) } });
    const write = vi.spyOn(f.store, "upsertProviderConfigWithResponsibility");
    await service.upsertTenantProvider(f.tenantId, responsibilityProvider());
    expect(capture).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![0].targetReference).toMatchObject({
      domain: "external_credential", disposition: "executable_ref", adapterProtocol: "managed-fixture-target-v1",
    });
    const targets = [...f.store.tenantCredentialTargetDispositions.values()]
      .filter((target) => target.tenantId === f.tenantId && target.domain === "external_credential");
    expect(targets).toHaveLength(1);
    expect(targets[0]!.disposition).toBe("executable_ref");
    const request = await f.admit(); await f.clearLocal(); await f.drainRuntime();
    const result = await f.store.getTenantCredentialResponsibilityReadiness(f.tenantId, request.requestId);
    expect(result).toMatchObject({ status: "unknown", remoteCredentials: "unknown", allDomainsComplete: false });
    expect(result!.unknownMaterialCount).toBeGreaterThan(0);
    expect([...f.store.tenantCredentialTargetDispositions.values()]
      .filter((target) => target.tenantId === f.tenantId && target.domain === "external_credential")).toEqual(targets);
  });
});
