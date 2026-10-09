import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  SubjectDeletingError,
  newErasureRequestId,
  tenantErasureRequestHash,
} from "@agent-service/store";
import { DEFAULT_AUTH_POLICY } from "@agent-service/protocol";
import {
  TenantRuntimeCoordinator,
  TenantRuntimeDrainTimeoutError,
} from "@agent-service/core";
import { LocalAesGcmCipher, ProviderService, assertPublicBaseUrl } from "../src/index.js";

const KEY = "11".repeat(32);
// Offline-deterministic: the real DNS-backed checker is covered by its own test at the bottom.
const assertBaseUrl = async () => {};

async function gateTenant(store: MemorySessionStore, tenantId: string): Promise<void> {
  // Tenant-wide erasure admits only canonical tenant-registry targets. Provider rows alone are
  // intentionally insufficient evidence because a typo could otherwise reserve a future id.
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await store.requestTenantErasure({
    requestId: newErasureRequestId(),
    tenantId,
    requestedByKeyId: "admin-key",
    idempotencyKey: "erase-once",
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: 1_800_000_000_000,
  });
}

describe("ProviderService", () => {
  it("encrypts BYOK keys at rest, never returns them, and decrypts per request", async () => {
    const store = new MemorySessionStore();
    const svc = new ProviderService({ store, cipher: new LocalAesGcmCipher(KEY), platform: [ProviderService.preset("dashscope", "platform-key")], assertBaseUrl });
    const cfg = await svc.upsertTenantProvider("t_a", {
      id: "mine", api: "openai-completions", baseUrl: "https://example.com/v1", headers: {}, quota: {}, fallback: [],
      models: [{ id: "m1", contextWindow: 1000, maxOutputTokens: 100, input: ["text"], reasoning: false, price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      apiKey: "sk-secret",
    });
    expect(JSON.stringify(cfg)).not.toContain("sk-secret");
    expect(cfg.apiKeyRef).toBe("secret:t_a:mine");
    const stored = await store.getProviderConfig("t_a", "mine");
    expect(stored?.secret?.ciphertext.toString()).not.toContain("sk-secret");

    const r = await svc.resolve({ tenantId: "t_a", userId: "u" }, { provider: "mine", model: "m1" });
    expect(await r.apiKey()).toBe("sk-secret");
    expect(r.provider).toBe("t_a:mine");
    expect(r.input).toEqual(["text"]);
    expect(r.priceKnown).toBe(true);
    expect((r.handle as { cost: { input: number } }).cost.input).toBe(1);

    // another tenant cannot see it and falls through to platform presets only
    await expect(svc.resolve({ tenantId: "t_b", userId: "u" }, { provider: "mine", model: "m1" })).rejects.toMatchObject({ code: "not_found" });
    const plat = await svc.resolve({ tenantId: "t_b", userId: "u" }, { provider: "dashscope", model: "qwen-plus" });
    expect(await plat.apiKey()).toBe("platform-key");
    expect(plat.provider).toBe("platform:dashscope");
    expect((await svc.listVisible("t_b")).map((c) => c.id)).toEqual(["dashscope"]);
    expect((await svc.listVisible("t_a")).map((c) => c.id)).toEqual(["mine", "dashscope"]);
  });

  it("encodes tenant and provider registration components without cross-tenant collisions", async () => {
    const store = new MemorySessionStore();
    const svc = new ProviderService({ store, cipher: new LocalAesGcmCipher(KEY), assertBaseUrl });
    const base = {
      api: "openai-completions" as const,
      headers: {}, quota: {}, fallback: [],
      models: [{ id: "m", contextWindow: 10, maxOutputTokens: 1, input: ["text" as const], reasoning: false }],
    };

    // These distinct tuples both produced "tenant:/%:p" when joined with a raw colon.
    const left = await svc.upsertTenantProvider("tenant:/%", {
      ...base, id: "p", baseUrl: "https://left.example/v1", apiKey: "left-key",
    });
    const right = await svc.upsertTenantProvider("tenant", {
      ...base, id: "/%:p", baseUrl: "https://right.example/v1", apiKey: "right-key",
    });
    expect(left.apiKeyRef).toBe("secret:tenant:tenant%3A%2F%25:p");
    expect(right.apiKeyRef).toBe("secret:tenant:tenant:%2F%25%3Ap");

    const leftResolved = await svc.resolve({ tenantId: "tenant:/%", userId: "u" }, { provider: "p", model: "m" });
    const rightResolved = await svc.resolve({ tenantId: "tenant", userId: "u" }, { provider: "/%:p", model: "m" });
    expect(leftResolved.provider).toBe("tenant:tenant%3A%2F%25:p");
    expect(rightResolved.provider).toBe("tenant:tenant:%2F%25%3Ap");
    expect(leftResolved.provider).not.toBe(rightResolved.provider);
    expect(await leftResolved.apiKey()).toBe("left-key");
    expect(await rightResolved.apiKey()).toBe("right-key");
    expect((leftResolved.handle as { baseUrl: string }).baseUrl).toBe("https://left.example/v1");
    expect((rightResolved.handle as { baseUrl: string }).baseUrl).toBe("https://right.example/v1");
  });

  it("keeps a tenant named platform isolated from the platform provider scope", async () => {
    const store = new MemorySessionStore();
    let vendorCalls = 0;
    const rejectAtVendor: typeof fetch = async () => {
      vendorCalls += 1;
      return new Response(JSON.stringify({ error: { message: "fixture rejection" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    };
    const svc = new ProviderService({
      store,
      cipher: new LocalAesGcmCipher(KEY),
      assertBaseUrl,
      fetch: rejectAtVendor,
      platform: [{
        config: {
          id: "shared", api: "openai-completions", baseUrl: "https://platform.example/v1",
          headers: {}, quota: {}, fallback: [],
          models: [{ id: "m", contextWindow: 10, maxOutputTokens: 1, input: ["text"], reasoning: false }],
        },
        apiKey: "platform-key",
      }],
    });
    await svc.upsertTenantProvider("platform", {
      id: "shared", api: "openai-completions", baseUrl: "https://tenant.example/v1",
      headers: {}, quota: {}, fallback: [],
      models: [{ id: "m", contextWindow: 10, maxOutputTokens: 1, input: ["text"], reasoning: false }],
      apiKey: "tenant-key",
    });

    const tenantModel = await svc.resolve(
      { tenantId: "platform", userId: "u" },
      { provider: "shared", model: "m" },
    );
    const platformModel = await svc.resolve(
      { tenantId: "other", userId: "u" },
      { provider: "shared", model: "m" },
    );

    expect(tenantModel.provider).toBe("tenant:platform:shared");
    expect(platformModel.provider).toBe("platform:shared");
    expect(await tenantModel.apiKey()).toBe("tenant-key");
    expect(await platformModel.apiKey()).toBe("platform-key");
    expect((tenantModel.handle as { baseUrl: string }).baseUrl).toBe("https://tenant.example/v1");
    expect((platformModel.handle as { baseUrl: string }).baseUrl).toBe("https://platform.example/v1");

    for (const model of [tenantModel, platformModel]) {
      const result = await svc.models.streamSimple(
        model.handle as never,
        { messages: [{ role: "user", content: "registry probe", timestamp: Date.now() }] },
        { apiKey: await model.apiKey(), fetch: model.fetch },
      ).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).not.toMatch(/unknown provider/i);
    }
    expect(vendorCalls).toBe(2);
  });

  it("revokes an already-resolved BYOK key and outbound fetch when the tenant is gated", async () => {
    const store = new MemorySessionStore();
    let fetchCalls = 0;
    const outboundFetch: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    };
    const svc = new ProviderService({
      store,
      cipher: new LocalAesGcmCipher(KEY),
      fetch: outboundFetch,
      assertBaseUrl,
    });
    await svc.upsertTenantProvider("tenant-revoked-byok", {
      id: "mine", api: "openai-completions", baseUrl: "https://example.com/v1",
      headers: { "X-Tenant-Secret": "header-value" }, quota: {}, fallback: [],
      models: [{ id: "m", contextWindow: 10, maxOutputTokens: 1, input: ["text"], reasoning: false }],
      apiKey: "byok-value",
    });
    const resolved = await svc.resolve(
      { tenantId: "tenant-revoked-byok", userId: "u" },
      { provider: "mine", model: "m" },
    );
    expect(resolved.headers).toEqual({ "X-Tenant-Secret": "header-value" });
    expect((await resolved.fetch!("https://provider.example/v1")).status).toBe(204);
    expect(fetchCalls).toBe(1);
    fetchCalls = 0;

    await gateTenant(store, "tenant-revoked-byok");

    await expect(resolved.apiKey()).rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(resolved.fetch!("https://provider.example/v1"))
      .rejects.toBeInstanceOf(SubjectDeletingError);
    expect(fetchCalls).toBe(0);
  });

  it("revokes keyless platform fallback before new or already-resolved outbound work", async () => {
    const store = new MemorySessionStore();
    let fetchCalls = 0;
    const outboundFetch: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    };
    const svc = new ProviderService({
      store,
      cipher: new LocalAesGcmCipher(KEY),
      fetch: outboundFetch,
      assertBaseUrl,
      platform: [{
        config: {
          id: "keyless", api: "openai-completions", baseUrl: "https://platform.example/v1",
          headers: { "X-Platform-Auth": "header-value" }, quota: {}, fallback: [],
          models: [{ id: "m", contextWindow: 10, maxOutputTokens: 1, input: ["text"], reasoning: false }],
        },
      }],
    });
    const resolved = await svc.resolve(
      { tenantId: "tenant-revoked-platform", userId: "u" },
      { provider: "keyless", model: "m" },
    );
    expect(resolved.headers).toEqual({ "X-Platform-Auth": "header-value" });
    expect(await resolved.apiKey()).toBeUndefined();

    await gateTenant(store, "tenant-revoked-platform");

    await expect(resolved.apiKey()).rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(resolved.fetch!("https://platform.example/v1"))
      .rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(svc.resolve(
      { tenantId: "tenant-revoked-platform", userId: "u" },
      { provider: "keyless", model: "m" },
    )).rejects.toBeInstanceOf(SubjectDeletingError);
    expect(fetchCalls).toBe(0);
  });

  it("fails closed for provider list and upsert after the tenant is gated", async () => {
    const store = new MemorySessionStore();
    const svc = new ProviderService({
      store,
      cipher: new LocalAesGcmCipher(KEY),
      platform: [ProviderService.preset("dashscope", "platform-key")],
      assertBaseUrl,
    });
    await gateTenant(store, "tenant-provider-management");

    await expect(svc.listVisible("tenant-provider-management"))
      .rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(svc.upsertTenantProvider("tenant-provider-management", {
      id: "mine", api: "openai-completions", baseUrl: "https://example.com/v1",
      headers: {}, quota: {}, fallback: [],
      models: [{ id: "m", contextWindow: 10, maxOutputTokens: 1, input: ["text"], reasoning: false }],
      apiKey: "must-not-be-stored",
    })).rejects.toBeInstanceOf(SubjectDeletingError);
  });

  it("exposes the selected model's text and image input capabilities", async () => {
    const svc = new ProviderService({
      store: new MemorySessionStore(),
      cipher: new LocalAesGcmCipher(KEY),
      platform: [{
        config: {
          id: "modalities",
          api: "openai-completions",
          baseUrl: "https://example.com/v1",
          headers: {},
          quota: {},
          fallback: [],
          models: [
            { id: "text-only", contextWindow: 1_000, maxOutputTokens: 100, input: ["text"], reasoning: false },
            { id: "vision", contextWindow: 2_000, maxOutputTokens: 200, input: ["text", "image"], reasoning: false },
          ],
        },
      }],
      assertBaseUrl,
    });

    const principal = { tenantId: "t_modalities", userId: "u" };
    await expect(svc.resolve(principal, { provider: "modalities", model: "text-only" }))
      .resolves.toMatchObject({ input: ["text"], priceKnown: false });
    await expect(svc.resolve(principal, { provider: "modalities", model: "vision" }))
      .resolves.toMatchObject({ input: ["text", "image"] });
  });

  it("rejects invalid model capability declarations at the provider write boundary", async () => {
    const store = new MemorySessionStore();
    const svc = new ProviderService({ store, cipher: new LocalAesGcmCipher(KEY), assertBaseUrl });
    for (const [index, input] of [[], ["image"], ["text", "text"], ["image", "image"]].entries()) {
      await expect(svc.upsertTenantProvider("t", {
        id: `invalid-${index}`,
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        headers: {},
        quota: {},
        fallback: [],
        models: [{
          id: "m",
          contextWindow: 1_000,
          maxOutputTokens: 100,
          input: input as never,
          reasoning: false,
        }],
      })).rejects.toBeDefined();
    }
    expect(await store.listProviderConfigs("t")).toEqual([]);
  });

  it("rejects unknown models with the available list", async () => {
    const svc = new ProviderService({ store: new MemorySessionStore(), cipher: new LocalAesGcmCipher(KEY), platform: [ProviderService.preset("deepseek", "k")], assertBaseUrl });
    await expect(svc.resolve({ tenantId: "t", userId: "u" }, { provider: "deepseek", model: "nope" })).rejects.toMatchObject({ code: "invalid_request", details: { available: ["deepseek-chat", "deepseek-reasoner"] } });
  });

  it("re-registers a pi provider when the tenant config changes", async () => {
    const store = new MemorySessionStore();
    const svc = new ProviderService({ store, cipher: new LocalAesGcmCipher(KEY), assertBaseUrl });
    const base = { id: "p", api: "openai-completions" as const, headers: {}, quota: {}, fallback: [], models: [{ id: "m", contextWindow: 10, maxOutputTokens: 1, input: ["text" as const], reasoning: false }] };
    await svc.upsertTenantProvider("t", { ...base, baseUrl: "https://a.example/v1", apiKey: "k1" });
    const r1 = await svc.resolve({ tenantId: "t", userId: "u" }, { provider: "p", model: "m" });
    await new Promise((r) => setTimeout(r, 2));
    await svc.upsertTenantProvider("t", { ...base, baseUrl: "https://b.example/v1" });
    const r2 = await svc.resolve({ tenantId: "t", userId: "u" }, { provider: "p", model: "m" });
    expect((r1.handle as { baseUrl: string }).baseUrl).toBe("https://a.example/v1");
    expect((r2.handle as { baseUrl: string }).baseUrl).toBe("https://b.example/v1");
    expect(await r2.apiKey()).toBe("k1"); // key kept when omitted on update
  });

  it("rejects a BYOK baseUrl that is not a public http(s) endpoint (SSRF)", async () => {
    const svc = new ProviderService({ store: new MemorySessionStore(), cipher: new LocalAesGcmCipher(KEY) });
    const base = { id: "p", api: "openai-completions" as const, headers: {}, quota: {}, fallback: [], models: [{ id: "m", contextWindow: 10, maxOutputTokens: 1, input: ["text" as const], reasoning: false }], apiKey: "k" };
    for (const baseUrl of [
      "http://127.0.0.1:8787/v1",
      "http://169.254.169.254/latest",
      "http://[::1]/v1",
      "https://user:secret@1.1.1.1/v1",
      "https://user@1.1.1.1/v1",
      "file:///etc/passwd",
      "not-a-url",
    ]) {
      await expect(svc.upsertTenantProvider("t", { ...base, baseUrl })).rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(assertPublicBaseUrl("https://user:secret@1.1.1.1/v1"))
      .rejects.toMatchObject({ code: "invalid_request", message: "baseUrl must not contain credentials" });
    const injectedGuard = new ProviderService({
      store: new MemorySessionStore(),
      cipher: new LocalAesGcmCipher(KEY),
      assertBaseUrl: async () => {},
    });
    await expect(injectedGuard.upsertTenantProvider("t", {
      ...base,
      baseUrl: "https://user:secret@example.com/v1",
    })).rejects.toMatchObject({
      code: "invalid_request",
      message: "baseUrl must not contain credentials",
    });
    await expect(assertPublicBaseUrl("https://1.1.1.1/v1")).resolves.toBeUndefined();
  });

  it("drains provider response bodies and removes only the fenced tenant's registrations", async () => {
    const store = new MemorySessionStore();
    const runtime = new TenantRuntimeCoordinator();
    let bodyCancelled = false;
    const svc = new ProviderService({
      store,
      cipher: new LocalAesGcmCipher(KEY),
      tenantRuntime: runtime,
      assertBaseUrl,
      platform: [ProviderService.preset("deepseek", "platform-key")],
      fetch: async () => new Response(new ReadableStream({
        pull: () => new Promise<void>(() => {}),
        cancel: () => { bodyCancelled = true; },
      }), { status: 200 }),
    });
    await svc.upsertTenantProvider("t_drain", {
      id: "mine", api: "openai-completions", baseUrl: "https://example.com/v1", headers: {}, quota: {}, fallback: [],
      models: [{ id: "m", contextWindow: 1000, maxOutputTokens: 100, input: ["text"], reasoning: false }],
      apiKey: "tenant-key",
    });
    const tenantModel = await svc.resolve({ tenantId: "t_drain", userId: "u" }, { provider: "mine", model: "m" });
    const platformModel = await svc.resolve({ tenantId: "another", userId: "u" }, { provider: "deepseek", model: "deepseek-chat" });
    runtime.sealParticipants();
    const response = await tenantModel.fetch!("https://provider.example/v1");
    expect(response.body).not.toBeNull();
    expect(runtime.snapshot("t_drain")).toMatchObject({ providerRegistrations: 1, providerOperations: 1 });

    const result = await runtime.drain({
      requestId: "ter_provider_body",
      tenantId: "t_drain",
      subjectGeneration: 1,
      t3aReceiptSha256: "cd".repeat(32),
    }, 1_000);
    expect(bodyCancelled).toBe(true);
    expect(result).toMatchObject({
      cacheEntryCountBefore: 1,
      cacheEntryCountAfter: 0,
      activeOperationCountBefore: 1,
      activeOperationCountAfter: 0,
    });
    expect(svc.models.getModel(tenantModel.provider, tenantModel.model)).toBeUndefined();
    expect(svc.models.getModel(platformModel.provider, platformModel.model)).toBeDefined();
    await expect(svc.listVisible("t_drain")).rejects.toBeInstanceOf(SubjectDeletingError);
  });

  it("waits for a late non-cooperative provider response body to finish cancelling", async () => {
    const store = new MemorySessionStore();
    const runtime = new TenantRuntimeCoordinator();
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    let releaseFetch!: () => void;
    const fetchBlocked = new Promise<void>((resolve) => { releaseFetch = resolve; });
    let cancelStarted!: () => void;
    const cancelling = new Promise<void>((resolve) => { cancelStarted = resolve; });
    let releaseCancel!: () => void;
    const cancelBlocked = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const svc = new ProviderService({
      store,
      cipher: new LocalAesGcmCipher(KEY),
      tenantRuntime: runtime,
      assertBaseUrl,
      platform: [ProviderService.preset("deepseek", "platform-key")],
      fetch: async () => {
        fetchStarted();
        await fetchBlocked; // deliberately ignores the supplied AbortSignal
        return new Response(new ReadableStream({
          cancel: async () => {
            cancelStarted();
            await cancelBlocked;
          },
        }), { status: 200 });
      },
    });
    const model = await svc.resolve(
      { tenantId: "t_late_provider_body", userId: "u" },
      { provider: "deepseek", model: "deepseek-chat" },
    );
    runtime.sealParticipants();
    const fetching = model.fetch!("https://provider.example/v1");
    await started;
    const identity = {
      requestId: "ter_late_provider_body",
      tenantId: "t_late_provider_body",
      subjectGeneration: 1,
      t3aReceiptSha256: "ac".repeat(32),
    };
    const drainExpectation = expect(runtime.drain(identity, 20))
      .rejects.toBeInstanceOf(TenantRuntimeDrainTimeoutError);
    releaseFetch();
    await cancelling;
    await drainExpectation;
    expect(runtime.snapshot(identity.tenantId).providerOperations).toBe(1);

    releaseCancel();
    await expect(fetching).rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(runtime.drain(identity, 1_000)).resolves.toMatchObject({
      activeOperationCountAfter: 0,
    });
  });

  it("waits for an in-flight decrypt and never returns its plaintext after the fence", async () => {
    const store = new MemorySessionStore();
    const runtime = new TenantRuntimeCoordinator();
    const delegate = new LocalAesGcmCipher(KEY);
    let decryptStarted!: () => void;
    const started = new Promise<void>((resolve) => { decryptStarted = resolve; });
    let releaseDecrypt!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
    const svc = new ProviderService({
      store,
      tenantRuntime: runtime,
      assertBaseUrl,
      cipher: {
        keyId: delegate.keyId,
        encrypt: (plaintext) => delegate.encrypt(plaintext),
        decrypt: async (ciphertext, keyId) => {
          decryptStarted();
          await blocked;
          return delegate.decrypt(ciphertext, keyId);
        },
      },
    });
    await svc.upsertTenantProvider("t_decrypt", {
      id: "mine", api: "openai-completions", baseUrl: "https://example.com/v1", headers: {}, quota: {}, fallback: [],
      models: [{ id: "m", contextWindow: 1000, maxOutputTokens: 100, input: ["text"], reasoning: false }],
      apiKey: "must-not-return",
    });
    const model = await svc.resolve({ tenantId: "t_decrypt", userId: "u" }, { provider: "mine", model: "m" });
    runtime.sealParticipants();
    const key = model.apiKey();
    await started;
    const drain = runtime.drain({
      requestId: "ter_provider_decrypt",
      tenantId: "t_decrypt",
      subjectGeneration: 1,
      t3aReceiptSha256: "ef".repeat(32),
    }, 1_000);
    releaseDecrypt();
    await expect(key).rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(drain).resolves.toMatchObject({ activeOperationCountBefore: 1, activeOperationCountAfter: 0 });
  });
});
