import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "@agent-service/store";
import { LocalAesGcmCipher, ProviderService, assertPublicBaseUrl } from "../src/index.js";

const KEY = "11".repeat(32);
// Offline-deterministic: the real DNS-backed checker is covered by its own test at the bottom.
const assertBaseUrl = async () => {};

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
    expect((r.handle as { cost: { input: number } }).cost.input).toBe(1);

    // another tenant cannot see it and falls through to platform presets only
    await expect(svc.resolve({ tenantId: "t_b", userId: "u" }, { provider: "mine", model: "m1" })).rejects.toMatchObject({ code: "not_found" });
    const plat = await svc.resolve({ tenantId: "t_b", userId: "u" }, { provider: "dashscope", model: "qwen-plus" });
    expect(await plat.apiKey()).toBe("platform-key");
    expect(plat.provider).toBe("platform:dashscope");
    expect((await svc.listVisible("t_b")).map((c) => c.id)).toEqual(["dashscope"]);
    expect((await svc.listVisible("t_a")).map((c) => c.id)).toEqual(["mine", "dashscope"]);
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
    for (const baseUrl of ["http://127.0.0.1:8787/v1", "http://169.254.169.254/latest", "http://[::1]/v1", "file:///etc/passwd", "not-a-url"]) {
      await expect(svc.upsertTenantProvider("t", { ...base, baseUrl })).rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(assertPublicBaseUrl("https://1.1.1.1/v1")).resolves.toBeUndefined();
  });
});
