import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemorySessionStore } from "@agent-service/store";
import type { ProviderConfigInput } from "@agent-service/protocol";
import {
  LocalAesGcmCipher,
  ProviderService,
  type ProviderCredentialTargetReferenceContext,
} from "../src/index.js";

const KEY = "31".repeat(32);
const assertBaseUrl = async () => {};

function provider(overrides: Partial<ProviderConfigInput> = {}): ProviderConfigInput {
  return {
    id: "managed-provider",
    api: "openai-completions",
    baseUrl: "https://provider.example/v1?tenant-visible=value",
    headers: { "X-Tenant-Header": "credential-bearing-value" },
    quota: {},
    fallback: [],
    models: [{
      id: "model",
      contextWindow: 1_000,
      maxOutputTokens: 100,
      input: ["text"],
      reasoning: false,
    }],
    apiKey: "tenant-api-key",
    ...overrides,
  };
}

describe("ProviderService credential target reference capture", () => {
  it("captures via trusted injection, protects independently, and passes only protected data", async () => {
    const store = new MemorySessionStore();
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
    const write = vi.spyOn(store, "upsertProviderConfig");
    const captures: ProviderCredentialTargetReferenceContext[] = [];
    const protectedInputs: Buffer[] = [];
    const svc = new ProviderService({
      store,
      cipher: new LocalAesGcmCipher(KEY, "byok-secret-key-v1"),
      assertBaseUrl,
      credentialTargetReferenceFactory: {
        capture: async (context) => {
          captures.push({ ...context });
          expect(Object.isFrozen(context)).toBe(true);
          return {
            adapterProtocol: "managed-provider-revoke-v1",
            opaqueReference: Buffer.from("server-owned-management-id"),
          };
        },
      },
      credentialTargetReferenceProtector: {
        protect: async (plaintext) => {
          protectedInputs.push(Buffer.from(plaintext));
          return {
            ciphertext: Buffer.concat([Buffer.from("sealed:"), Buffer.from(plaintext)]),
            keyId: "target-reference-key-v1",
          };
        },
      },
    });

    const publicInput = provider() as ProviderConfigInput & {
      targetReference?: string;
      adapterProtocol?: string;
    };
    publicInput.targetReference = "attacker-controlled-locator";
    publicInput.adapterProtocol = "attacker-protocol";
    const result = await svc.upsertTenantProvider("tenant-managed", publicInput);

    expect(captures).toEqual([{
      tenantId: "tenant-managed",
      providerId: "managed-provider",
      providerApi: "openai-completions",
      encryptedSecretPresent: true,
      customHeadersPresent: true,
      endpointParametersPresent: true,
    }]);
    expect(protectedInputs).toEqual([Buffer.from("server-owned-management-id")]);
    expect(result).not.toHaveProperty("targetReference");
    expect(result).not.toHaveProperty("adapterProtocol");
    expect(JSON.stringify(result)).not.toContain("server-owned-management-id");
    expect(JSON.stringify(result)).not.toContain("attacker-controlled-locator");

    const calls = write.mock.calls as unknown as Array<unknown[]>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(4);
    const target = calls[0]![3] as Record<string, unknown>;
    const ciphertext = Buffer.from("sealed:server-owned-management-id");
    expect(target).toEqual({
      domain: "external_credential",
      disposition: "executable_ref",
      adapterProtocol: "managed-provider-revoke-v1",
      targetReferenceCipher: ciphertext,
      targetReferenceKeyId: "target-reference-key-v1",
      targetReferenceCipherSha256: createHash("sha256").update(ciphertext).digest("hex"),
      targetReferenceSha256: createHash("sha256")
        .update("server-owned-management-id")
        .digest("hex"),
    });
  });

  it("preserves the blocker path when capture is absent or returns no trusted mapping", async () => {
    const store = new MemorySessionStore();
    const write = vi.spyOn(store, "upsertProviderConfig");
    const capture = vi.fn(async () => undefined);
    const protect = vi.fn(async () => ({
      ciphertext: Buffer.from("unused"),
      keyId: "unused-key-v1",
    }));
    const svc = new ProviderService({
      store,
      cipher: new LocalAesGcmCipher(KEY),
      assertBaseUrl,
      credentialTargetReferenceFactory: { capture },
      credentialTargetReferenceProtector: { protect },
    });

    await svc.upsertTenantProvider("tenant-blocked", provider());
    expect(capture).toHaveBeenCalledOnce();
    expect(protect).not.toHaveBeenCalled();
    expect((write.mock.calls as unknown as Array<unknown[]>)[0]).toHaveLength(3);

    const noFactoryStore = new MemorySessionStore();
    const noFactoryWrite = vi.spyOn(noFactoryStore, "upsertProviderConfig");
    await new ProviderService({
      store: noFactoryStore,
      cipher: new LocalAesGcmCipher(KEY),
      assertBaseUrl,
    }).upsertTenantProvider("tenant-no-factory", provider());
    expect((noFactoryWrite.mock.calls as unknown as Array<unknown[]>)[0]).toHaveLength(3);
  });

  it("does not call trusted capture for a credential-free provider", async () => {
    const store = new MemorySessionStore();
    const capture = vi.fn(async () => ({
      adapterProtocol: "must-not-run-v1",
      opaqueReference: Buffer.from("must-not-run"),
    }));
    const protect = vi.fn(async () => ({
      ciphertext: Buffer.from("must-not-run"),
      keyId: "must-not-run-v1",
    }));
    const svc = new ProviderService({
      store,
      cipher: new LocalAesGcmCipher(KEY),
      assertBaseUrl,
      credentialTargetReferenceFactory: { capture },
      credentialTargetReferenceProtector: { protect },
    });

    await svc.upsertTenantProvider("tenant-keyless", provider({
      baseUrl: "https://provider.example/v1",
      headers: {},
      apiKey: undefined,
    }));
    expect(capture).not.toHaveBeenCalled();
    expect(protect).not.toHaveBeenCalled();
  });

  it("fails atomically when trusted capture protection fails", async () => {
    const store = new MemorySessionStore();
    const write = vi.spyOn(store, "upsertProviderConfig");
    const source = Buffer.from("server-owned-management-id");
    const svc = new ProviderService({
      store,
      cipher: new LocalAesGcmCipher(KEY),
      assertBaseUrl,
      credentialTargetReferenceFactory: {
        capture: async () => ({
          adapterProtocol: "managed-provider-revoke-v1",
          opaqueReference: source,
        }),
      },
      credentialTargetReferenceProtector: {
        protect: async () => {
          throw new Error("protector leaked server-owned-management-id");
        },
      },
    });

    let failure: unknown;
    try {
      await svc.upsertTenantProvider("tenant-protection-failure", provider());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "provider credential target reference capture failed",
    );
    expect(String(failure)).not.toContain("server-owned-management-id");
    expect((failure as Error).cause).toBeUndefined();
    expect(source).toEqual(Buffer.alloc(source.length));
    expect(write).not.toHaveBeenCalled();
    expect(await store.getProviderConfig("tenant-protection-failure", "managed-provider"))
      .toBeNull();
  });

  it("replaces trusted factory errors with a content-free failure", async () => {
    const store = new MemorySessionStore();
    const write = vi.spyOn(store, "upsertProviderConfig");
    const svc = new ProviderService({
      store,
      cipher: new LocalAesGcmCipher(KEY),
      assertBaseUrl,
      credentialTargetReferenceFactory: {
        capture: async () => {
          throw new Error("remote response included secret-management-locator");
        },
      },
      credentialTargetReferenceProtector: {
        protect: async () => ({
          ciphertext: Buffer.from("unused"),
          keyId: "unused-v1",
        }),
      },
    });

    let failure: unknown;
    try {
      await svc.upsertTenantProvider("tenant-factory-failure", provider());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "provider credential target reference capture failed",
    );
    expect(String(failure)).not.toContain("secret-management-locator");
    expect((failure as Error).cause).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it("requires trusted capture and protection to be configured as one boundary", () => {
    const store = new MemorySessionStore();
    expect(() => new ProviderService({
      store,
      cipher: new LocalAesGcmCipher(KEY),
      assertBaseUrl,
      credentialTargetReferenceFactory: { capture: async () => undefined },
    })).toThrow(/factory and protector must be configured together/);
  });
});
